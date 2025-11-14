#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const cwd = process.cwd();
const tracesDir = path.resolve(cwd, argValue('--dir', path.join('data', 'traces')));
const outputDir = path.resolve(cwd, argValue('--outdir', path.join('data', 'evals')));
const failOnFallback = args.includes('--strict');

function collectTraceFiles(dir) {
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const stats = fs.statSync(current);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        walk(path.join(current, entry));
      }
      return;
    }
    if (stats.isFile() && current.toLowerCase().endsWith('.json')) {
      files.push(current);
    }
  }
  walk(dir);
  return files;
}

function evaluateTrace(file) {
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { file, issues: [`invalid_json:${err.message}`], status: 'fail' };
  }
  const trace = Array.isArray(payload.trace) ? payload.trace : [];
  const planEntries = trace.filter((entry) => entry && entry.tool === 'plan');
  const toolEntries = trace.filter((entry) => entry && entry.tool && entry.tool !== 'plan');
  const answer = String(payload.answer || payload.message?.content || '').trim();
  const chartSeries = Array.isArray(payload.chart?.series) ? payload.chart.series : [];
  const issues = [];

  if (!planEntries.length) issues.push('missing_plan');
  if (!toolEntries.length) issues.push('no_tools');
  if (!/^Overview:/i.test(answer)) issues.push('missing_overview');
  if (!/Details:/i.test(answer)) issues.push('missing_details');
  if (failOnFallback && /No telemetry data/i.test(answer)) issues.push('fallback_answer');

  for (const series of chartSeries) {
    if (!series || (!series.dataRef && !series.data)) {
      issues.push('chart_missing_series');
      break;
    }
    if (series.data && Array.isArray(series.data) && series.data.length > 20) {
      issues.push('chart_embedded_array');
      break;
    }
    if (!series.dataRef) {
      issues.push('chart_missing_dataRef');
      break;
    }
  }

  const status = issues.length ? 'fail' : 'pass';
  return { file, issues, status };
}

function main() {
  const files = collectTraceFiles(tracesDir);
  if (!files.length) {
    console.error(`[eval] No trace files found under ${tracesDir}`);
    process.exit(1);
  }

  const results = files.map(evaluateTrace);
  const passes = results.filter((r) => r.status === 'pass').length;
  const fails = results.filter((r) => r.status === 'fail');

  console.log(`Evaluated ${results.length} traces. Passes: ${passes}. Fails: ${fails.length}.`);
  if (fails.length) {
    console.log('\nFailures:');
    for (const fail of fails.slice(0, 20)) {
      console.log(`- ${path.relative(cwd, fail.file)} :: ${fail.issues.join(', ')}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `summary_${Date.now()}.json`);
  const summary = {
    generatedAt: new Date().toISOString(),
    root: cwd,
    tracesDir,
    total: results.length,
    passes,
    fails: fails.length,
    failDetails: fails
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[eval] Summary written to ${summaryPath}`);

  if (fails.length) {
    process.exitCode = 1;
  }
}

main();
