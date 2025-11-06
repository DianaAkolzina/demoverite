#!/usr/bin/env node
/**
 * Quick telemetry audit utility.
 *
 * For every device CSV under CSVex_s3, this script prints the
 * first and last timestamp present (in ISO8601, UTC) along with
 * the number of rows detected. Files with no telemetry rows are
 * called out explicitly so they can be excluded from scope/tests.
 */

import fs from 'fs/promises';
import path from 'path';

const CSV_ROOT = process.env.CSV_DIR || path.join(process.cwd(), 'CSVex_s3');

async function listCsvFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.csv'))
    .map((ent) => path.join(dir, ent.name))
    .sort();
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(',');
  if (!parts.length) return null;
  const ts = Number(parts[0]);
  return Number.isFinite(ts) ? ts : null;
}

function formatTs(ts) {
  if (ts == null) return 'n/a';
  return new Date(ts).toISOString();
}

async function readFirstLast(file) {
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length <= 1) {
    return { first: null, last: null, rows: 0 };
  }
  const dataLines = lines.slice(1);
  const firstTs = parseLine(dataLines[0]);
  let lastTs = null;
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    const ts = parseLine(dataLines[i]);
    if (ts != null) {
      lastTs = ts;
      break;
    }
  }
  return {
    first: firstTs,
    last: lastTs,
    rows: dataLines.length
  };
}

async function main() {
  const files = await listCsvFiles(CSV_ROOT);
  if (!files.length) {
    console.error(`[check_csv_date_ranges] No CSV files under ${CSV_ROOT}`);
    process.exit(1);
  }

  const results = [];
  for (const file of files) {
    try {
      const stats = await readFirstLast(file);
      results.push({ file, ...stats });
    } catch (err) {
      console.error(`[check_csv_date_ranges] Failed to read ${file}: ${err.message}`);
    }
  }

  results.sort((a, b) => {
    if (a.first == null) return 1;
    if (b.first == null) return -1;
    return a.first - b.first;
  });

  console.log('Device CSV coverage (UTC):');
  for (const entry of results) {
    const deviceId = path.basename(entry.file, '.csv');
    const first = formatTs(entry.first);
    const last = formatTs(entry.last);
    const rowInfo = `${entry.rows} row${entry.rows === 1 ? '' : 's'}`;
    const status = entry.rows ? 'OK' : 'EMPTY';
    console.log(`${status.padEnd(6)} ${deviceId}  rows=${rowInfo.padEnd(10)}  first=${first}  last=${last}`);
  }
}

main().catch((err) => {
  console.error('[check_csv_date_ranges] fatal', err);
  process.exit(1);
});

