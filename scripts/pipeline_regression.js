#!/usr/bin/env node
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TESTS_DIR = path.join(DATA_DIR, 'tests');
const TRACES_DIR = path.join(DATA_DIR, 'traces');
const PIPELINE_TMP_DIR = path.join(DATA_DIR, 'pipeline_tmp');

const WARMUP_TOKEN = '[startup][llm] Warmup ok';
const WARMUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const TEST_RUNS = [
  { label: 'scope', description: 'Commerce scope/device coverage suites', command: ['node', 'scripts/test_scope_runs.js'] }
];

function logInfo(message) {
  console.log(`[pipeline] ${message}`);
}

function logError(message) {
  console.error(`[pipeline] ERROR: ${message}`);
}

async function runCommand(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function startServer() {
  logInfo('Starting server (node server/index.js)…');
  const child = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForWarmup(serverProcess) {
  logInfo('Waiting for LLM warmup acknowledgement…');
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Warmup message not observed within ${WARMUP_TIMEOUT_MS / 1000}s`));
      }
    }, WARMUP_TIMEOUT_MS);

    function handleData(data) {
      const text = data.toString();
      if (text.includes(WARMUP_TOKEN)) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          logInfo('LLM warmup confirmed.');
          cleanup();
          resolve();
        }
      }
    }

    function handleExit(code) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Server exited before warmup (code ${code})`));
      }
    }

    function cleanup() {
      serverProcess.stdout?.off('data', handleData);
      serverProcess.stderr?.off('data', handleData);
      serverProcess.off('exit', handleExit);
    }

    serverProcess.stdout?.on('data', handleData);
    serverProcess.stderr?.on('data', handleData);
    serverProcess.once('exit', handleExit);
  });
}

async function ensurePdflatexAvailable() {
  try {
    await runCommand('which', ['pdflatex']);
  } catch {
    throw new Error('pdflatex not found in PATH. Install TeX Live (or similar) to compile PDFs.');
  }
}

async function listTraceFiles(dir) {
  try {
    const entries = await fsPromises.readdir(dir);
    return new Set(entries.filter((f) => f.endsWith('.json')));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function copyNewTraces(beforeSet, dir, destinationRoot, label) {
  const afterEntries = await fsPromises.readdir(dir).catch(() => []);
  const newFiles = afterEntries.filter((f) => f.endsWith('.json') && !beforeSet.has(f));
  if (!newFiles.length) return { tempDir: null, files: [] };

  const slug = `${label}_${timestampSlug()}`;
  const tempDir = path.join(destinationRoot, slug);
  await fsPromises.mkdir(tempDir, { recursive: true });
  for (const file of newFiles) {
    const src = path.join(dir, file);
    const dest = path.join(tempDir, file);
    await fsPromises.copyFile(src, dest);
  }
  logInfo(`Captured ${newFiles.length} new trace files for ${label}.`);
  return { tempDir, files: newFiles };
}

async function generateLatexAndPdf({ tracesDir, outputBase }) {
  await fsPromises.mkdir(TESTS_DIR, { recursive: true });
  await fsPromises.mkdir(tracesDir, { recursive: true });

  const texPath = path.join(TESTS_DIR, `${outputBase}.tex`);
  const pdfPath = path.join(TESTS_DIR, `${outputBase}.pdf`);

  logInfo(`Creating LaTeX report (${outputBase})…`);
  await runCommand('python3', [
    'scripts/traces_to_latex.py',
    '--traces-dir',
    tracesDir,
    '--output',
    texPath
  ]);

  logInfo(`Compiling ${outputBase}.tex -> PDF…`);
  await runCommand('pdflatex', [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-output-directory',
    TESTS_DIR,
    texPath
  ]);

  const auxExtensions = ['.aux', '.log', '.out', '.toc'];
  await Promise.all(
    auxExtensions.map(async (ext) => {
      const file = texPath.replace(/\.tex$/i, ext);
      try {
        await fsPromises.unlink(file);
      } catch {}
    })
  );

  logInfo(`PDF generated at ${pdfPath}`);
  return pdfPath;
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(key = '') {
  return key.split('/').map((seg) => encodeRfc3986(seg)).join('/');
}

function hashHex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function resolveS3Host(bucket, region, forcePathStyle) {
  const base = region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${region}.amazonaws.com`;
  if (forcePathStyle || bucket.includes('.')) {
    return { host: base, pathPrefix: `/${bucket}` };
  }
  return { host: `${bucket}.${base}`, pathPrefix: '' };
}

function buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((v) => `${encodeRfc3986(key)}=${encodeRfc3986(v)}`);
      }
      return `${encodeRfc3986(key)}=${encodeRfc3986(value)}`;
    })
    .sort()
    .join('&');
}

function signRequest({ method, region, service, host, canonicalUri, query, headers, accessKey, secretKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') + 'Z';
  const dateStamp = amzDate.substring(0, 8);
  headers['x-amz-date'] = amzDate;
  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).trim()}\n`)
    .sort()
    .join('');
  const signedHeaders = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256']
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashHex(canonicalRequest)
  ].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ');
  return { authorization, amzDate };
}

async function uploadPdfToS3(pdfPath, { label }) {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    throw new Error('AWS_S3_BUCKET is required to upload the PDF.');
  }
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    throw new Error('AWS credentials missing (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).');
  }

  const region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  const rawPrefix = (process.env.AWS_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const keyRoot = rawPrefix ? `${rawPrefix}/tests` : 'tests';
  const timestamp = timestampSlug();
  const fileName = `${label}_${timestamp}.pdf`;
  const objectKey = `${keyRoot}/${label}/${fileName}`;
  const fileBuffer = await fsPromises.readFile(pdfPath);
  const contentType = 'application/pdf';

  const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === '1';
  const { host, pathPrefix } = resolveS3Host(bucket, region, forcePathStyle);
  let canonicalUri = pathPrefix || '';
  const encodedKey = encodePath(objectKey);
  canonicalUri += `${canonicalUri ? '/' : '/'}${encodedKey}`;

  const service = 's3';
  const queryString = buildQuery({});
  const url = `https://${host}${canonicalUri}${queryString ? `?${queryString}` : ''}`;

  const headers = {
    Host: host,
    'Content-Type': contentType,
    'Content-Length': fileBuffer.length,
    'x-amz-content-sha256': hashHex(fileBuffer)
  };
  if (process.env.AWS_SESSION_TOKEN) {
    headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  }
  const { authorization, amzDate } = signRequest({
    method: 'PUT',
    region,
    service,
    host,
    canonicalUri,
    query: queryString,
    headers,
    accessKey,
    secretKey
  });
  headers.Authorization = authorization;
  headers['x-amz-date'] = amzDate;

  logInfo(`Uploading PDF to s3://${bucket}/${objectKey} …`);
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: fileBuffer
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText} ${text}`);
  }
  logInfo(`Upload complete → s3://${bucket}/${objectKey}`);
  return { bucket, key: objectKey };
}

async function runTestSuite({ label, description, command }, baselineTraces) {
  logInfo(`Running test suite "${label}" — ${description}`);
  const before = new Set(baselineTraces);
  const result = await runCommand(command[0], command.slice(1));

  // Attempt to log the results path if present
  const match = result.stdout.match(/Saved to (.*\.json)/);
  if (match) {
    logInfo(`Test results saved to ${match[1].trim()}`);
  }

  const { tempDir, files } = await copyNewTraces(before, TRACES_DIR, PIPELINE_TMP_DIR, label);
  if (!tempDir || !files.length) {
    logInfo(`No new traces detected for ${label}; skipping LaTeX/PDF generation for this run.`);
    return { pdfPath: null, s3: null, traceDir: null };
  }

  const outputBase = `${label}_traces_${timestampSlug()}`;
  const pdfPath = await generateLatexAndPdf({ tracesDir: tempDir, outputBase });
  const uploadInfo = await uploadPdfToS3(pdfPath, { label });

  return { pdfPath, s3: uploadInfo, traceDir: tempDir };
}

function detachServer(serverProcess) {
  try {
    serverProcess.stdout?.removeAllListeners('data');
    serverProcess.stderr?.removeAllListeners('data');
    serverProcess.unref();
    serverProcess.stdout?.unref?.();
    serverProcess.stderr?.unref?.();
    logInfo(`Server left running (PID ${serverProcess.pid}). Use "kill ${serverProcess.pid}" to stop it manually.`);
  } catch (err) {
    logError(`Failed to detach server process: ${err.message || err}`);
  }
}

async function main() {
  await fsPromises.mkdir(TESTS_DIR, { recursive: true });
  await fsPromises.mkdir(PIPELINE_TMP_DIR, { recursive: true });

  logInfo('Installing dependencies (npm install)…');
  await runCommand('npm', ['install', '--no-audit', '--no-fund']);

  await ensurePdflatexAvailable();

  const server = startServer();
  let serverExited = false;
  server.once('exit', () => { serverExited = true; });

  try {
    await waitForWarmup(server);

    // Baseline trace list before running suites
    let baselineTraces = await listTraceFiles(TRACES_DIR);

    const pdfUploads = [];
    for (const test of TEST_RUNS) {
      const result = await runTestSuite(test, baselineTraces);
      baselineTraces = await listTraceFiles(TRACES_DIR);
      if (result.pdfPath && result.s3) {
        pdfUploads.push(result.s3);
      }
      if (result.traceDir) {
        // Clean up temporary trace bundle after PDF generation
        await fsPromises.rm(result.traceDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (pdfUploads.length) {
      logInfo('Uploaded reports:');
      pdfUploads.forEach((item) => logInfo(`- s3://${item.bucket}/${item.key}`));
    } else {
      logInfo('No PDFs were generated/uploaded.');
    }
  } finally {
    if (!serverExited) {
      detachServer(server);
    }
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exitCode = 1;
});
