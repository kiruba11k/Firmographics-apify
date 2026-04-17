/**
 * groqService.js
 * Strict structured extraction via Groq LLM.
 * Anti-hallucination: only extract what is EXPLICITLY stated in provided text.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ─── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a business intelligence analyst extracting firmographic data from web search results and company pages.

═══════════════════════════════════════════════
ANTI-HALLUCINATION RULES — NON-NEGOTIABLE
═══════════════════════════════════════════════
1. ONLY extract values that are EXPLICITLY stated in the provided source text.
2. If a field is NOT mentioned in the text, return null — never guess or infer.
3. For numeric ranges, only use numbers that appear in the text.
4. For funding/revenue, only report figures directly stated — never estimate from stage.
5. DO NOT use your training knowledge about well-known companies — only use the provided text.
6. If you see conflicting data across sources, prefer the higher-quality source:
   Knowledge Graph > Crunchbase > LinkedIn > Other organic.
7. Set data_confidence based on how many DISTINCT signals confirm the data:
   - "high"   = 3+ independent sources agree
   - "medium" = 1–2 sources with clear statements
   - "low"    = single mention or unclear / conflicting data

═══════════════════════════════════════════════
EXTRACTION RULES PER FIELD
═══════════════════════════════════════════════
company_name:
  Use the canonical company name as stated in Knowledge Graph or official sources.

industry:
  Use a SHORT standard label: "SaaS", "Fintech", "E-commerce", "Healthcare IT", etc.
  Only from text — do not guess from domain.

headquarters:
  Format: "City, State, Country" or "City, Country". Only from text.

description:
  Max 150 chars. Plain factual sentence from the source. No marketing language.

employee_min / employee_max:
  Extract from explicit statements ONLY:
  - "~500 employees" → min: 375, max: 625
  - "500–1000 employees" → min: 500, max: 1000
  - "over 10,000" → min: 10000, max: null
  - "fewer than 50" → min: null, max: 50
  If only a single approximate number: use ±25% range.
  If vague like "small team" or no number: return null for both.

revenue_min_usd / revenue_max_usd (integers in USD):
  - "$5M ARR" → min: 4500000, max: 5500000
  - "$100M–$500M" → min: 100000000, max: 500000000
  - "over $1B" → min: 1000000000, max: null
  Convert M → multiply by 1,000,000 | B → multiply by 1,000,000,000 | K → multiply by 1,000
  If no explicit revenue figure: null.

funding_stage_include:
  Must be one of EXACTLY: "pre-seed" | "seed" | "series-a" | "series-b" | "series-c" |
  "series-d+" | "growth" | "ipo" | "public" | "bootstrapped" | "unknown"
  Only if explicitly stated in text.

total_funding_usd (integer):
  Only if a total raised figure is explicitly stated. Convert to integer USD.
  "raised $50M" → 50000000

notable_investors:
  Comma-separated list of investor names ONLY if explicitly mentioned in text.

evidence_url:
  The exact URL from the source tag (e.g. [Organic Source: URL]) that contained the
  most important firmographic fact (prefer funding/revenue/employee source).

founded_year_min / founded_year_max:
  If exact year: both equal that year. If "founded in the early 2010s": min: 2010, max: 2014.

company_status:
  Must be one of EXACTLY: "active" | "acquired" | "merged" | "bankrupt" | "closed" | "ipo" | "unknown"
  Default to "active" only if the company clearly appears operational in the text.
  Otherwise: "unknown".

═══════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════
Respond ONLY with a valid JSON object. No markdown, no code fences, no explanation.

{
  "company_name": string | null,
  "company_domain": string | null,
  "industry": string | null,
  "headquarters": string | null,
  "description": string | null,
  "employee_min": integer | null,
  "employee_max": integer | null,
  "revenue_min_usd": integer | null,
  "revenue_max_usd": integer | null,
  "funding_stage_include": string | null,
  "total_funding_usd": integer | null,
  "evidence_url": string | null,
  "founded_year_min": integer | null,
  "founded_year_max": integer | null,
  "company_status": string | null,
  "notable_investors": string | null,
  "data_confidence": "high" | "medium" | "low"
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely parse Groq response — handles markdown fences and stray text
 */
function safeParseJson(raw) {
  if (!raw) throw new Error('Empty response');

  // Strip markdown fences
  let clean = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  // Find the first { ... } block
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');

  return JSON.parse(clean.slice(start, end + 1));
}

/**
 * Validate and normalise extracted fields against allowed enums
 */
function normaliseResult(result, domain) {
  const VALID_STATUSES = new Set(['active', 'acquired', 'merged', 'bankrupt', 'closed', 'ipo', 'unknown']);
  const VALID_STAGES = new Set([
    'pre-seed', 'seed', 'series-a', 'series-b', 'series-c',
    'series-d+', 'growth', 'ipo', 'public', 'bootstrapped', 'unknown',
  ]);

  // Always set domain
  result.company_domain = result.company_domain || domain;

  // Normalise status
  if (result.company_status) {
    const s = result.company_status.toLowerCase().trim();
    result.company_status = VALID_STATUSES.has(s) ? s : 'unknown';
  }

  // Normalise funding stage
  if (result.funding_stage_include) {
    const stage = result.funding_stage_include
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace('series-a', 'series-a')  // pass-through for valid
      .replace('series-b', 'series-b')
      .replace('series-c', 'series-c');
    result.funding_stage_include = VALID_STAGES.has(stage) ? stage : null;
  }

  // Ensure integers are integers (not strings)
  const intFields = [
    'employee_min', 'employee_max',
    'revenue_min_usd', 'revenue_max_usd',
    'total_funding_usd', 'founded_year_min', 'founded_year_max',
  ];
  for (const field of intFields) {
    if (result[field] !== null && result[field] !== undefined) {
      const parsed = parseInt(result[field], 10);
      result[field] = isNaN(parsed) ? null : parsed;
    }
  }

  // Sanity checks — remove implausible values
  if (result.employee_min !== null && result.employee_min < 0) result.employee_min = null;
  if (result.employee_max !== null && result.employee_max > 10_000_000) result.employee_max = null;
  if (result.founded_year_min !== null && (result.founded_year_min < 1800 || result.founded_year_min > new Date().getFullYear())) {
    result.founded_year_min = null;
  }
  if (result.founded_year_max !== null && (result.founded_year_max < 1800 || result.founded_year_max > new Date().getFullYear())) {
    result.founded_year_max = null;
  }

  // Truncate description
  if (result.description && result.description.length > 150) {
    result.description = result.description.slice(0, 147) + '...';
  }

  return result;
}

// ─── Groq Call with Retry ─────────────────────────────────────────────────────

async function callGroq(userContent, apiKey, model, fetchFn, retries = 2) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.0,         // Deterministic — no creativity wanted here
    max_tokens: 700,
    response_format: { type: 'json_object' },
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchFn(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers?.get?.('retry-after') || '5', 10);
          const waitMs = Math.max(retryAfter * 1000, (attempt + 1) * 4000);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`Groq API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq');

      return safeParseJson(content);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }

  throw lastErr;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractFirmographics(domain, serpContext, apiKey, model, fetchFn, log) {
  // Trim context to fit within model token limits — prioritise high-signal sections
  const MAX_CONTEXT_CHARS = 8000;
  const trimmedContext = serpContext.length > MAX_CONTEXT_CHARS
    ? serpContext.slice(0, MAX_CONTEXT_CHARS) + '\n[Context truncated]'
    : serpContext;

  const userContent = `Extract firmographic data for domain: ${domain}

IMPORTANT: Extract ONLY what is explicitly stated in the sources below. Return null for any field not mentioned.

${trimmedContext}

Return the JSON object only.`;

  try {
    const result = await callGroq(userContent, apiKey, model, fetchFn);
    const normalised = normaliseResult(result, domain);

    log?.info?.(`Extracted firmographics for ${domain} [confidence: ${normalised.data_confidence}]`);
    return normalised;
  } catch (err) {
    log?.error?.(`Groq extraction failed for ${domain}: ${err.message}`);
    return {
      company_domain: domain,
      company_name: null,
      industry: null,
      headquarters: null,
      description: null,
      employee_min: null,
      employee_max: null,
      revenue_min_usd: null,
      revenue_max_usd: null,
      funding_stage_include: null,
      total_funding_usd: null,
      evidence_url: null,
      founded_year_min: null,
      founded_year_max: null,
      company_status: null,
      notable_investors: null,
      data_confidence: 'low',
      error: err.message,
    };
  }
}
