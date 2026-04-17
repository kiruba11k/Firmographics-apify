/**
 * csvUtils.js
 * Handles CSV parsing (input) and CSV generation (output).
 */
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

/** CSV column order for output */
export const CSV_COLUMNS = [
  'company_domain',
  'company_name',
  'industry',
  'headquarters',
  'description',
  'employee_min',
  'employee_max',
  'revenue_min_usd',
  'revenue_max_usd',
  'funding_stage_include',
  'total_funding_usd',
  'evidence_url',
  'founded_year_min',
  'founded_year_max',
  'company_status',
  'notable_investors',
  'data_confidence',
  'error',
  'enriched_at',
];

/**
 * Parse CSV content and extract website URLs from the specified column
 */
export function parseUrlsFromCsv(csvContent, columnName = 'website') {
  let records;
  try {
    records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    throw new Error(`Failed to parse CSV: ${err.message}`);
  }

  if (!records.length) throw new Error('CSV file is empty');

  const availableColumns = Object.keys(records[0]);
  const fallbackCols = ['website', 'url', 'Website', 'URL', 'domain', 'Domain', 'company_url'];
  const targetCol =
    availableColumns.find(c => c === columnName) ||
    availableColumns.find(c => fallbackCols.includes(c));

  if (!targetCol) {
    throw new Error(
      `Column "${columnName}" not found. Available: ${availableColumns.join(', ')}`
    );
  }

  const urls = records
    .map(r => r[targetCol])
    .filter(Boolean)
    .map(url => normalizeUrl(url));

  return {
    urls: [...new Set(urls.filter(Boolean))],
    totalRows: records.length,
    columnUsed: targetCol,
  };
}

/**
 * Normalize a URL — ensure https:// prefix
 */
export function normalizeUrl(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.toLowerCase();
  if (raw.includes('.')) return `https://${raw.toLowerCase()}`;
  return null;
}

/**
 * Extract hostname from URL
 */
export function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Convert array of firmographic records to CSV string
 */
export function recordsToCsv(records) {
  const rows = records.map(r => {
    const row = {};
    for (const col of CSV_COLUMNS) {
      const val = r[col];
      row[col] = val === undefined || val === null ? '' : String(val);
    }
    return row;
  });
  return stringify(rows, { header: true, columns: CSV_COLUMNS });
}

/**
 * Format large USD numbers for display
 */
export function formatUsd(amount) {
  if (!amount) return '';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}
