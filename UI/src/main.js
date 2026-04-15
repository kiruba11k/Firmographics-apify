/**
 * main.js — Firmographic Enrichment Actor
 *
 * Pipeline:
 *  1. Read input (single URL or CSV file URL)
 *  2. For each company domain:
 *     a. Run 3 Google SERP queries (via SerpApi AI mode)
 *     b. Aggregate all text snippets + AI overviews + knowledge graph
 *     c. Send to Groq LLM for structured extraction
 *  3. Push each result to Apify Dataset
 *  4. Optionally save CSV to Key-Value store
 */

import { Actor, log } from 'apify';
import fetch from 'node-fetch';
import { gatherCompanyContext } from './serpService.js';
import { extractFirmographics } from './groqService.js';
import {
  parseUrlsFromCsv,
  normalizeUrl,
  extractDomain,
  recordsToCsv,
} from './csvUtils.js';

// ─── Main ────────────────────────────────────────────────────────────────────

await Actor.init();

try {
  const input = await Actor.getInput();

  // ── Validate required inputs ──────────────────────────────────────────────
  if (!input) throw new Error('No input provided. Please configure the actor input.');
  if (!input.serpApiKey) throw new Error('serpApiKey is required. Get a free key at https://serpapi.com');
  if (!input.groqApiKey) throw new Error('groqApiKey is required. Get a free key at https://console.groq.com');

  const {
    websiteUrl,
    csvFileUrl,
    csvColumnName = 'website',
    serpApiKey,
    groqApiKey,
    groqModel = 'llama-3.1-8b-instant',
    maxConcurrency = 3,
    delayBetweenRequestsMs = 1000,
    outputFormat = 'both',
  } = input;

  if (!websiteUrl && !csvFileUrl) {
    throw new Error('Either websiteUrl or csvFileUrl must be provided.');
  }

  // ── Collect URLs ──────────────────────────────────────────────────────────
  let urlsToProcess = [];

  if (websiteUrl) {
    const normalized = normalizeUrl(websiteUrl);
    if (!normalized) throw new Error(`Invalid website URL: ${websiteUrl}`);
    urlsToProcess.push(normalized);
    log.info(`Single URL mode: ${normalized}`);
  }

  if (csvFileUrl) {
    log.info(`Fetching CSV from: ${csvFileUrl}`);
    let csvResp;
    try {
      csvResp = await fetch(csvFileUrl);
    } catch (err) {
      throw new Error(`Failed to fetch CSV file: ${err.message}`);
    }
    if (!csvResp.ok) {
      throw new Error(`CSV fetch failed with status ${csvResp.status}: ${csvFileUrl}`);
    }
    const csvContent = await csvResp.text();
    const { urls, totalRows, columnUsed } = parseUrlsFromCsv(csvContent, csvColumnName);
    log.info(`CSV parsed: ${totalRows} rows → ${urls.length} unique URLs (column: "${columnUsed}")`);
    urlsToProcess.push(...urls);
  }

  // Deduplicate
  urlsToProcess = [...new Set(urlsToProcess)];
  log.info(`Total URLs to enrich: ${urlsToProcess.length}`);

  if (urlsToProcess.length === 0) {
    throw new Error('No valid URLs found to process.');
  }

  // ── Process URLs with concurrency control ─────────────────────────────────
  const results = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // Chunk URLs for concurrency
  async function processUrl(url) {
    const domain = extractDomain(url);
    log.info(`[${processed + 1}/${urlsToProcess.length}] Processing: ${domain}`);

    await Actor.setStatusMessage(
      `Enriching ${processed + 1}/${urlsToProcess.length}: ${domain}`
    );

    const record = {
      company_domain: domain,
      input_url: url,
      enriched_at: new Date().toISOString(),
    };

    try {
      // Step 1: SERP research
      const serpContext = await gatherCompanyContext(url, serpApiKey, fetch, log);

      if (!serpContext.trim()) {
        log.warning(`No SERP context found for ${domain}`);
        record.error = 'No SERP data found';
        record.data_confidence = 'low';
      } else {
        // Step 2: LLM extraction
        const firmographics = await extractFirmographics(
          domain,
          serpContext,
          groqApiKey,
          groqModel,
          fetch,
          log
        );
        Object.assign(record, firmographics);
        succeeded++;
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

  // Process with concurrency limit
  async function processWithConcurrency(urls, concurrency) {
    const queue = [...urls];
    const active = new Set();

    async function runNext() {
      if (!queue.length) return;
      const url = queue.shift();
      const promise = processUrl(url).finally(() => {
        active.delete(promise);
        // Delay before next
        return new Promise((r) => setTimeout(r, delayBetweenRequestsMs));
      });
      active.add(promise);
      await promise;
      if (queue.length) await runNext();
    }

    // Start initial batch
    const initial = Math.min(concurrency, urls.length);
    await Promise.all(Array.from({ length: initial }, runNext));
  }

  await processWithConcurrency(urlsToProcess, maxConcurrency);

  log.info(`\n✅ Enrichment complete: ${succeeded} succeeded, ${failed} failed out of ${urlsToProcess.length} URLs`);

  // ── Save CSV to Key-Value Store ───────────────────────────────────────────
  if (outputFormat === 'csv_only' || outputFormat === 'both') {
    const csvContent = recordsToCsv(results);
    const store = await Actor.openKeyValueStore();
    await store.setValue('firmographic_results.csv', csvContent, { contentType: 'text/csv' });

    const storeId = store.id;
    log.info(`CSV saved to Key-Value Store: ${storeId}/firmographic_results.csv`);

    // Log the public URL
    const kvUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/firmographic_results.csv`;
    log.info(`Download CSV at: ${kvUrl}`);

    // Save summary to KV store too
    await store.setValue('enrichment_summary', {
      total: urlsToProcess.length,
      succeeded,
      failed,
      csvUrl: kvUrl,
      completedAt: new Date().toISOString(),
      model: groqModel,
    });
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  await Actor.setStatusMessage(
    `Done! Enriched ${succeeded}/${urlsToProcess.length} companies. ${failed} failed.`
  );

  log.info('Actor finished successfully.');
} catch (err) {
  log.error(`Actor failed: ${err.message}`);
  await Actor.setStatusMessage(`Error: ${err.message}`);
  throw err;
} finally {
  await Actor.exit();
}
