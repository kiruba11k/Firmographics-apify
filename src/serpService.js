/**
 * serpService.js
 * Queries SerpApi with Google AI Mode (ai_overview) to get rich company info.
 * Falls back to organic results if AI overview not available.
 */

const SERP_BASE = 'https://serpapi.com/search.json';

/**
 * Build firmographic search queries for a company domain
 */
function buildQueries(domain) {
  const company = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return [
    `${company} company number of employees revenue funding`,
    `${company} company founded year funding stage total raised`,
    `${company} headquarters industry sector company size`,
  ];
}

/**
 * Fetch Google SERP results with AI Overview for a query
 */
async function fetchSerpResult(query, apiKey, fetchFn) {
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: 'google',
    q: query,
    num: '5',
    hl: 'en',
    gl: 'us',
  });

  const url = `${SERP_BASE}?${params.toString()}`;
  const resp = await fetchFn(url);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`SerpApi error ${resp.status}: ${errText}`);
  }

  return resp.json();
}

/**
 * Extract text snippets from SERP result (AI overview, Knowledge Graph, Answer Box, Organic)
 */
function extractTextFromSerp(serpData) {
  const parts = [];

  // 1. AI Overview
  if (serpData.ai_overview) {
    const ao = serpData.ai_overview;
    if (ao.text_blocks) {
      for (const block of ao.text_blocks) {
        if (block.type === 'paragraph' && block.snippet) {
          parts.push(`[AI Overview] ${block.snippet}`);
        } else if (block.type === 'list' && block.list) {
          for (const item of block.list) {
            if (item.snippet) parts.push(`[AI Overview List] ${item.snippet}`);
          }
        }
      }
    }
    if (ao.snippet) parts.push(`[AI Overview] ${ao.snippet}`);
  }

  // 2. Knowledge Graph
  if (serpData.knowledge_graph) {
    const kg = serpData.knowledge_graph;
    if (kg.description) parts.push(`[Knowledge Graph] ${kg.description}`);
    if (kg.founded) parts.push(`[Knowledge Graph] Founded: ${kg.founded}`);
    if (kg.headquarters) parts.push(`[Knowledge Graph] Headquarters: ${kg.headquarters}`);
    if (kg.number_of_employees) parts.push(`[Knowledge Graph] Employees: ${kg.number_of_employees}`);
    if (kg.revenue) parts.push(`[Knowledge Graph] Revenue: ${kg.revenue}`);
    if (kg.parent_organization) parts.push(`[Knowledge Graph] Parent: ${kg.parent_organization}`);
    if (kg.type) parts.push(`[Knowledge Graph] Type: ${kg.type}`);

    if (kg.attributes) {
      for (const [key, val] of Object.entries(kg.attributes)) {
        parts.push(`[Knowledge Graph] ${key}: ${val}`);
      }
    }
  }

  // 3. Answer box
  if (serpData.answer_box) {
    const ab = serpData.answer_box;
    if (ab.answer) parts.push(`[Answer Box] ${ab.answer}`);
    if (ab.snippet) parts.push(`[Answer Box] ${ab.snippet}`);
  }

  // 4. Organic results (top 5)
  if (serpData.organic_results) {
    for (const result of serpData.organic_results.slice(0, 5)) {
      if (result.snippet) {
        parts.push(`[Organic Source: ${result.link}] ${result.title}: ${result.snippet}`);
      }
    }
  }
  if (serpData.rich_snippet && serpData.rich_snippet.detected_extensions) {
  const ext = serpData.rich_snippet.detected_extensions;
  if (ext.revenue) parts.push(`[Rich Snippet] Revenue: ${ext.revenue}`);
  if (ext.employees) parts.push(`[Rich Snippet] Employees: ${ext.employees}`);
}

  return parts.join('\n');
}

/**
 * Main function: run multiple queries for a domain, collect all context
 */
export async function gatherCompanyContext(domain, apiKey, fetchFn, log) {
  const queries = buildQueries(domain);
  const allContext = [];
  let searchCount = 0;

  for (const query of queries) {
    try {
      // Safely check if log exists before calling debug
      if (log && typeof log.debug === 'function') log.debug(`SERP query: "${query}"`);
      
      const serpData = await fetchSerpResult(query, apiKey, fetchFn);
      const text = extractTextFromSerp(serpData);
      
      if (text.trim()) {
        allContext.push(`--- Query: "${query}" ---\n${text}`);
      }
      searchCount++;
    } catch (err) {
      if (log && typeof log.warning === 'function') {
        log.warning(`SERP query failed for "${query}": ${err.message}`);
      }
    }
  }

  if (log && typeof log.info === 'function') {
    log.info(`Gathered context from ${searchCount} SERP queries for ${domain}`);
  }
  
  return allContext.join('\n\n');
}
