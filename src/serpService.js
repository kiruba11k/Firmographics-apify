/**
 * serpService.js
 * Multi-source SERP enrichment with structured extraction.
 * Sources: Google AI Overview, Knowledge Graph, Organic, Crunchbase, LinkedIn, etc.
 */

const SERP_BASE = 'https://serpapi.com/search.json';

/**
 * Build targeted queries for a domain across multiple data signals
 */
function buildQueries(domain) {
  const company = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')[0]; // e.g. "stripe" from "stripe.com"

  return [
    // Employee + revenue signal
    `"${domain}" OR "${company}" company employees headcount revenue annual`,
    // Funding + investors signal
    `"${company}" funding raised investors series crunchbase`,
    // Headquarters + founding + industry
    `"${company}" founded year headquarters industry sector`,
    // Direct Crunchbase lookup (highly structured data)
    `site:crunchbase.com "${company}"`,
    // LinkedIn company page signal
    `site:linkedin.com/company "${company}" employees industry`,
  ];
}

/**
 * Fetch a single SERP query
 */
async function fetchSerpResult(query, apiKey, fetchFn) {
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: 'google',
    q: query,
    num: '7',
    hl: 'en',
    gl: 'us',
  });

  const resp = await fetchFn(`${SERP_BASE}?${params.toString()}`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`SerpApi error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

/**
 * Deep extraction from all SERP signals with source attribution
 */
function extractTextFromSerp(serpData, query) {
  const parts = [];

  // ── 1. AI Overview (highest signal) ──────────────────────────────────────
  if (serpData.ai_overview) {
    const ao = serpData.ai_overview;
    const aoSources = ao.sources?.map(s => s.link).join(', ') || '';

    if (ao.text_blocks) {
      for (const block of ao.text_blocks) {
        if (block.type === 'paragraph' && block.snippet) {
          parts.push(`[AI Overview${aoSources ? ` | sources: ${aoSources}` : ''}] ${block.snippet}`);
        }
        if (block.type === 'list' && block.list) {
          for (const item of block.list) {
            if (item.snippet) parts.push(`[AI Overview List] ${item.snippet}`);
          }
        }
      }
    }
    if (ao.snippet) parts.push(`[AI Overview] ${ao.snippet}`);
  }

  // ── 2. Knowledge Graph (structured company info) ──────────────────────────
  if (serpData.knowledge_graph) {
    const kg = serpData.knowledge_graph;
    const kgUrl = kg.website || '';

    if (kg.title) parts.push(`[Knowledge Graph | ${kgUrl}] Company Name: ${kg.title}`);
    if (kg.type) parts.push(`[Knowledge Graph | ${kgUrl}] Type: ${kg.type}`);
    if (kg.description) parts.push(`[Knowledge Graph | ${kgUrl}] Description: ${kg.description}`);
    if (kg.founded) parts.push(`[Knowledge Graph | ${kgUrl}] Founded: ${kg.founded}`);
    if (kg.headquarters) parts.push(`[Knowledge Graph | ${kgUrl}] Headquarters: ${kg.headquarters}`);
    if (kg.number_of_employees) parts.push(`[Knowledge Graph | ${kgUrl}] Employees: ${kg.number_of_employees}`);
    if (kg.revenue) parts.push(`[Knowledge Graph | ${kgUrl}] Revenue: ${kg.revenue}`);
    if (kg.parent_organization) parts.push(`[Knowledge Graph | ${kgUrl}] Parent: ${kg.parent_organization}`);
    if (kg.subsidiaries) parts.push(`[Knowledge Graph | ${kgUrl}] Subsidiaries: ${Array.isArray(kg.subsidiaries) ? kg.subsidiaries.join(', ') : kg.subsidiaries}`);
    if (kg.ceo) parts.push(`[Knowledge Graph | ${kgUrl}] CEO: ${kg.ceo}`);
    if (kg.founders) parts.push(`[Knowledge Graph | ${kgUrl}] Founders: ${Array.isArray(kg.founders) ? kg.founders.join(', ') : kg.founders}`);

    if (kg.profiles) {
      for (const p of kg.profiles) {
        if (p.name && p.link) parts.push(`[Knowledge Graph Profile] ${p.name}: ${p.link}`);
      }
    }

    if (kg.attributes) {
      for (const [key, val] of Object.entries(kg.attributes)) {
        parts.push(`[Knowledge Graph Attribute | ${kgUrl}] ${key}: ${val}`);
      }
    }
  }

  // ── 3. Answer Box ──────────────────────────────────────────────────────────
  if (serpData.answer_box) {
    const ab = serpData.answer_box;
    if (ab.answer) parts.push(`[Answer Box] ${ab.answer}`);
    if (ab.snippet) parts.push(`[Answer Box] ${ab.snippet}`);
    if (ab.snippets) {
      for (const s of ab.snippets) parts.push(`[Answer Box] ${s}`);
    }
  }

  // ── 4. Rich Snippet Extensions ────────────────────────────────────────────
  if (serpData.rich_snippet?.detected_extensions) {
    const ext = serpData.rich_snippet.detected_extensions;
    if (ext.revenue) parts.push(`[Rich Snippet] Revenue: ${ext.revenue}`);
    if (ext.employees) parts.push(`[Rich Snippet] Employees: ${ext.employees}`);
    if (ext.founded) parts.push(`[Rich Snippet] Founded: ${ext.founded}`);
  }

  // ── 5. Organic Results with domain priority ───────────────────────────────
  // Prioritise high-signal domains: crunchbase, linkedin, pitchbook, techcrunch, forbes
  const HIGH_SIGNAL_DOMAINS = [
    'crunchbase.com', 'linkedin.com', 'pitchbook.com',
    'techcrunch.com', 'forbes.com', 'businesswire.com',
    'prnewswire.com', 'sec.gov', 'bloomberg.com', 'owler.com',
  ];

  const organic = serpData.organic_results || [];

  // Sort: high-signal sources first
  const sorted = [...organic].sort((a, b) => {
    const aHigh = HIGH_SIGNAL_DOMAINS.some(d => (a.link || '').includes(d)) ? 0 : 1;
    const bHigh = HIGH_SIGNAL_DOMAINS.some(d => (b.link || '').includes(d)) ? 0 : 1;
    return aHigh - bHigh;
  });

  for (const result of sorted.slice(0, 7)) {
    const source = result.link || '';
    if (result.snippet) {
      parts.push(`[Organic Source: ${source}] ${result.title}: ${result.snippet}`);
    }
    // Rich snippet tables (employee counts, etc.)
    if (result.rich_snippet?.top?.detected_extensions) {
      const ext = result.rich_snippet.top.detected_extensions;
      if (ext.employees) parts.push(`[Rich Data: ${source}] Employees: ${ext.employees}`);
      if (ext.revenue) parts.push(`[Rich Data: ${source}] Revenue: ${ext.revenue}`);
      if (ext.founded) parts.push(`[Rich Data: ${source}] Founded: ${ext.founded}`);
    }
    // Inline sitelinks often have "About" pages with useful data
    if (result.sitelinks?.inline) {
      for (const sitelink of result.sitelinks.inline.slice(0, 2)) {
        if (sitelink.title && sitelink.link) {
          parts.push(`[Sitelink: ${sitelink.link}] ${sitelink.title}`);
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * Fetch the company's own /about page for direct facts (no hallucination risk)
 */
async function fetchAboutPage(domain, fetchFn, log) {
  const urls = [
    `https://${domain}/about`,
    `https://${domain}/about-us`,
    `https://${domain}/company`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetchFn(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FirmographicBot/1.0)' },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) continue;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await resp.text();

      // Naive but fast: extract visible text from common sections
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 3000);

      if (text.length > 200) {
        if (log?.debug) log.debug(`Fetched about page: ${url} (${text.length} chars)`);
        return `[Direct About Page: ${url}]\n${text}`;
      }
    } catch {
      // Silently skip; about page fetch is best-effort
    }
  }
  return '';
}

/**
 * Main: gather all context for a domain
 */
export async function gatherCompanyContext(domain, apiKey, fetchFn, log) {
  const queries = buildQueries(domain);
  const allContext = [];
  let searchCount = 0;

  // Run SERP queries
  for (const query of queries) {
    try {
      if (log?.debug) log.debug(`SERP query: "${query}"`);
      const serpData = await fetchSerpResult(query, apiKey, fetchFn);
      const text = extractTextFromSerp(serpData, query);

      if (text.trim()) {
        allContext.push(`=== Query: "${query}" ===\n${text}`);
      }
      searchCount++;
    } catch (err) {
      if (log?.warning) log.warning(`SERP query failed for "${query}": ${err.message}`);
    }
  }

  // Supplement with direct about page scrape
  try {
    const aboutText = await fetchAboutPage(domain, fetchFn, log);
    if (aboutText) {
      allContext.push(aboutText);
    }
  } catch {
    // Best-effort
  }

  if (log?.info) log.info(`Gathered context from ${searchCount} SERP queries + about page for ${domain}`);

  return allContext.join('\n\n');
}
