/**
 * groqService.js
 * Uses Groq LLM to extract structured firmographic data from raw SERP context.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a business intelligence analyst that extracts firmographic data about companies from web search snippets.

Extract ONLY what is explicitly mentioned in the provided text. Do NOT guess or hallucinate data.
If a field cannot be determined from the text, use null.

For numeric ranges (employees, revenue), extract reasonable min/max bounds:
- "~500 employees" → employee_min: 250, employee_max: 750
- "500-1000 employees" → employee_min: 500, employee_max: 1000
- "Series B startup" → funding_stage_include: "Series B"

Revenue ranges in USD:
- "$5M ARR" → revenue_min_usd: 4000000, revenue_max_usd: 6000000
- "$100M-$500M revenue" → revenue_min_usd: 100000000, revenue_max_usd: 500000000

Company status options: "active", "acquired", "merged", "bankrupt", "closed", "ipo", "unknown"
Funding stages: "pre-seed", "seed", "series-a", "series-b", "series-c", "series-d+", "growth", "ipo", "public", "bootstrapped", "unknown"

Respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "company_name": string or null,
  "company_domain": string or null,
  "industry": string or null,
  "headquarters": string or null,
  "description": string (max 150 chars) or null,
  "employee_min": integer or null,
  "employee_max": integer or null,
  "revenue_min_usd": integer or null,
  "revenue_max_usd": integer or null,
  "funding_stage_include": string or null,
  "total_funding_usd": integer or null,
  "founded_year_min": integer or null,
  "founded_year_max": integer or null,
  "company_status": string or null,
  "notable_investors": string or null,
  "data_confidence": "high" | "medium" | "low"
}`;

/**
 * Call Groq API with retry logic
 */
async function callGroq(systemPrompt, userContent, apiKey, model, fetchFn, retries = 2) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 600,
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
        // Rate limit - wait and retry
        if (resp.status === 429) {
          const waitMs = (attempt + 1) * 3000;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`Groq API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq');

      return JSON.parse(content);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }

  throw lastErr;
}

/**
 * Extract firmographic data from gathered SERP context
 */
export async function extractFirmographics(domain, serpContext, apiKey, model, fetchFn, log) {
  const userContent = `Extract firmographic data for the company at domain: ${domain}

Here is the gathered web search context:
${serpContext.slice(0, 6000)}

Return only the JSON object as specified.`;

  try {
    const result = await callGroq(SYSTEM_PROMPT, userContent, apiKey, model, fetchFn);

    // Ensure domain is always set
    result.company_domain = result.company_domain || domain;

    // Normalize status to lowercase
    if (result.company_status) {
      result.company_status = result.company_status.toLowerCase().trim();
    }

    // Normalize funding stage
    if (result.funding_stage_include) {
      result.funding_stage_include = result.funding_stage_include.toLowerCase().replace(' ', '-');
    }

    log.info(`Extracted firmographics for ${domain} [confidence: ${result.data_confidence}]`);
    return result;
  } catch (err) {
    log.error(`Groq extraction failed for ${domain}: ${err.message}`);

    // Return partial result with error
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
      founded_year_min: null,
      founded_year_max: null,
      company_status: null,
      notable_investors: null,
      data_confidence: 'low',
      error: err.message,
    };
  }
}
