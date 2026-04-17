/**
 * main.js — Firmographic Enrichment Actor
 *
 * Pipeline:
 *  1. Read input (single website URL)
 *  2. Run 5 targeted Google SERP queries + direct about-page scrape
 *  3. Aggregate all signals with source attribution
 *  4. Send to Groq LLM with strict anti-hallucination prompt
 *  5. Normalise + validate output
 *  6. Push to Apify Dataset + optionally save CSV to Key-Value Store
 */

import { Actor, log } from 'apify';
import { gatherCompanyContext } from './serpService.js';
import { extractFirmographics } from './groqService.js';
import {
  normalizeUrl,
  extractDomain,
  recordsToCsv,
  CSV_COLUMNS,
} from './csvUtils.js';

await Actor.init();

try {
  const input = await Actor.getInput();

  if (!input) throw new Error('No input provided. Please configure the actor input.');

  const {
    websiteUrl,
    serpApiKey: inputSerpApiKey,
    groqApiKey: inputGroqApiKey,
    groqModel = 'llama-3.3-70b-versatile', // Better accuracy for extraction
    maxConcurrency = 2,                      // Conservative default to respect rate limits
    delayBetweenRequestsMs = 1500,
    outputFormat = 'both',
  } = input;

  const serpApiKey = inputSerpApiKey || process.env.SERP_API_KEY;
  const groqApiKey = inputGroqApiKey || process.env.GROQ_API_KEY;

  if (!serpApiKey) throw new Error('Missing SerpApi key. Set SERP_API_KEY env var or provide serpApiKey in input.');
  if (!groqApiKey) throw new Error('Missing Groq key. Set GROQ_API_KEY env var or provide groqApiKey in input.');
  if (!websiteUrl) throw new Error('websiteUrl is required.');

  // ── Normalize and validate URL ─────────────────────────────────────────────
  const normalizedUrl = normalizeUrl(websiteUrl);
  if (!normalizedUrl) throw new Error(`Invalid website URL: ${websiteUrl}`);

  const urlsToProcess = [normalizedUrl];
  log.info(`Processing URL: ${normalizedUrl}`);

  // ── Core enrichment function ───────────────────────────────────────────────
  const results = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  async function processUrl(url) {
    const domain = extractDomain(url);
    const idx = processed + 1;
    const total = urlsToProcess.length;

    log.info(`[${idx}/${total}] Starting enrichment: ${domain}`);
    await Actor.setStatusMessage(`Enriching ${idx}/${total}: ${domain} — gathering SERP data...`);

    const record = {
      company_domain: domain,
      input_url: url,
      enriched_at: new Date().toISOString(),
    };

    try {
      // Step 1: Gather web context
      const serpContext = await gatherCompanyContext(domain, serpApiKey, fetch, log);

      if (!serpContext.trim()) {
        log.warning(`No SERP context gathered for ${domain}`);
        record.data_confidence = 'low';
        record.error = 'No SERP data returned — check SerpApi key or domain';
        failed++;
      } else {
        log.info(`Context gathered for ${domain} (${serpContext.length} chars). Running LLM extraction...`);
        await Actor.setStatusMessage(`Enriching ${idx}/${total}: ${domain} — running LLM extraction...`);

        // Step 2: Extract firmographics via LLM
        const firmographics = await extractFirmographics(
          domain,
          serpContext,
          groqApiKey,
          groqModel,
          fetch,
          log,
        );

        // Step 3: Map fields onto record (CSV_COLUMNS as source of truth)
        for (const col of CSV_COLUMNS) {
          if (firmographics[col] !== undefined) {
            record[col] = firmographics[col];
          }
        }

        // Also capture any error message from extraction
        if (firmographics.error) {
          record.error = firmographics.error;
        }

        succeeded++;
        log.info(`✓ ${domain}: confidence=${firmographics.data_confidence}, name="${firmographics.company_name}", employees=${firmographics.employee_min}–${firmographics.employee_max}`);
      }
    } catch (err) {
      log.error(`Failed to enrich ${domain}: ${err.message}`);
      record.error = err.message;
      record.data_confidence = 'low';
      failed++;
    }

    processed++;
    results.push(record);

    // Push to dataset immediately (streaming results)
    await Actor.pushData(record);

    return record;
  }

  // ── Concurrency-limited processing ────────────────────────────────────────
  async function processWithConcurrency(urls, concurrency) {
    const queue = [...urls];

    async function runNext() {
      if (!queue.length) return;
      const url = queue.shift();
      await processUrl(url);

      // Respect rate limits
      if (queue.length) {
        await new Promise(r => setTimeout(r, delayBetweenRequestsMs));
        await runNext();
      }
    }

    const initial = Math.min(concurrency, urls.length);
    await Promise.all(Array.from({ length: initial }, runNext));
  }

  await processWithConcurrency(urlsToProcess, maxConcurrency);

  log.info(`\n✅ Done: ${succeeded} succeeded, ${failed} failed out of ${urlsToProcess.length} URL(s)`);

  // ── Save CSV ───────────────────────────────────────────────────────────────
  if (outputFormat === 'csv_only' || outputFormat === 'both') {
    const csvContent = recordsToCsv(results);
    const store = await Actor.openKeyValueStore();
    await store.setValue('firmographic_results.csv', csvContent, { contentType: 'text/csv' });

    const storeId = store.id;
    const kvUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/firmographic_results.csv`;

    log.info(`CSV saved → ${kvUrl}`);

    await store.setValue('enrichment_summary', {
      total: urlsToProcess.length,
      succeeded,
      failed,
      csvUrl: kvUrl,
      completedAt: new Date().toISOString(),
      model: groqModel,
    });
  }

  await Actor.setStatusMessage(
    `✅ Done! Enriched ${succeeded}/${urlsToProcess.length} companies. ${failed} failed.`
  );

  log.info('Actor finished successfully.');
} catch (err) {
  log.error(`Actor failed: ${err.message}`);
  await Actor.setStatusMessage(`Error: ${err.message}`);
  throw err;
} finally {
  await Actor.exit();
}
