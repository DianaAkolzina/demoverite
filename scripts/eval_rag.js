#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildDocsFromData, buildRagIndex } from '../server/rag.js';
import { hybridRetrieve } from '../server/retrieval.js';
import { createVectorClient } from '../server/vector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const TEST_FILE = path.join(DATA_DIR, 'tests', 'rag_expectations.json');

if (!fs.existsSync(TEST_FILE)) {
  console.error(`[eval:rag] Missing test file ${TEST_FILE}`);
  process.exit(1);
}

const tests = JSON.parse(fs.readFileSync(TEST_FILE, 'utf8'));
if (!Array.isArray(tests) || !tests.length) {
  console.error('[eval:rag] No test cases defined.');
  process.exit(1);
}

const docs = buildDocsFromData({
  dataDir: DATA_DIR,
  rooms: [],
  loadRoomTables: () => ({}),
  knowledgeDir: KNOWLEDGE_DIR
});
const rag = buildRagIndex(docs, { debug: false });
const vector = process.env.CHROMA_URL ? createVectorClient({ chromaUrl: process.env.CHROMA_URL }) : null;

async function run() {
  let passes = 0;
  const failures = [];
  for (const test of tests) {
    const preferCategories = test.preferCategories || [];
    const scope = { metrics: test.metrics || [] };
    const hits = await hybridRetrieve({
      query: test.question,
      ragIndex: rag,
      vectorClient: vector,
      k: test.k || 6,
      preferCategories,
      scope
    }).catch(() => []);
    const top = hits?.[0];
    if (!top) {
      failures.push({ question: test.question, reason: 'no_hits' });
      continue;
    }
    let ok = true;
    if (test.expectCategory) {
      const cat = (top.meta?.category || top.meta?.type || '').toLowerCase();
      if (cat !== String(test.expectCategory).toLowerCase()) {
        ok = false;
        failures.push({ question: test.question, reason: `expected category ${test.expectCategory} got ${cat || 'n/a'}` });
      }
    }
    if (test.expectFileContains && ok) {
      const needle = String(test.expectFileContains).toLowerCase();
      const windowSize = test.window || 3;
      const found = hits.slice(0, windowSize).some((hit) => String(hit.meta?.file || '').toLowerCase().includes(needle));
      if (!found) {
        ok = false;
        failures.push({ question: test.question, reason: `top ${windowSize} docs missing ${test.expectFileContains}` });
      }
    }
    if (test.mustInclude && ok) {
      const needle = String(test.mustInclude).toLowerCase();
      if (!top.text?.toLowerCase().includes(needle)) {
        ok = false;
        failures.push({ question: test.question, reason: `top doc missing phrase "${test.mustInclude}"` });
      }
    }
    if (ok) passes += 1;
  }
  console.log(`[eval:rag] ${passes}/${tests.length} scenarios passed.`);
  if (failures.length) {
    failures.forEach((f) => console.log(` - ${f.question} :: ${f.reason}`));
    process.exitCode = 1;
  }
}

run();
