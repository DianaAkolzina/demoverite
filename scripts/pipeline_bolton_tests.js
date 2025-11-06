#!/usr/bin/env node
/**
 * End-to-end pipeline runner for the AVM Bolton scenarios.
 *
 * Steps:
 *  1. Install node dependencies (npm install).
 *  2. Start the server and wait for the LLM warmup log entry ("Warmup ok").
 *  3. Execute the Bolton test suite (scripts/run_avm_bolton_tests.js).
 *  4. Convert the latest traces into a LaTeX report and compile a PDF.
 *  5. Upload the PDF to S3 using the configured credentials, under a tests/ prefix.
 *
 * Required env for the upload:
 *  - AWS_S3_BUCKET
 *  - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN)
 * Optional:
 *  - AWS_S3_REGION / AWS_REGION (defaults to eu-west-2)
 *  - AWS_S3_PREFIX (prepended before the tests/ prefix)
 *  - AWS_S3_FORCE_PATH_STYLE=1 to force path-style URLs
 */

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

const WARMUP_TOKEN = '[startup][llm] Warmup ok';
const WARMUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function logInfo(message) {
  console.log(`[pipeline] ${message}`);
}

function logError(message) {
  console.error(`[pipeline] ERROR: ${message}`);
}

function runCommand(command, args, { cwd = ROOT, env = process.env, allowFailure = false } = {}) {
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
    child.on('error', (err) => {
      if (allowFailure) resolve({ code: 1, stdout, stderr, error: err });
      else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
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
    stdio: ['ignore', 'pipe', 'pipe']
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
      serverProcess.stdout.off('data', handleData);
      serverProcess.stderr.off('data', handleData);
      serverProcess.off('exit', handleExit);
    }

    serverProcess.stdout.on('data', handleData);
    serverProcess.stderr.on('data', handleData);
    serverProcess.once('exit', handleExit);
  });
}

async function ensurePdflatexAvailable() {
  const whichResult = await runCommand('which', ['pdflatex'], { allowFailure: true });
  if (whichResult.code !== 0) {
    throw new Error('pdflatex not found in PATH. Install TeX Live (or similar) to compile PDFs.');
  }
}

async function runBoltonTests() {
  logInfo('Running Bolton scenario tests…');
  const result = await runCommand('node', ['scripts/run_avm_bolton_tests.js']);
  const match = result.stdout.match(/Saved to (.*chat_avm_bolton_.*\.json)/);
  if (!match) {
    logError('Unable to detect results file from test output.');
  } else {
    logInfo(`Recorded Bolton results: ${match[1].trim()}`);
  }
}

async function generateLatexAndPdf() {
  await fsPromises.mkdir(TESTS_DIR, { recursive: true });
  await fsPromises.mkdir(TRACES_DIR, { recursive: true });

  const texPath = path.join(TESTS_DIR, 'bolton_traces_report.tex');
  const pdfPath = path.join(TESTS_DIR, 'bolton_traces_report.pdf');

  logInfo('Creating LaTeX report from traces…');
  await runCommand('python3', [
    'scripts/traces_to_latex.py',
    '--traces-dir',
    TRACES_DIR,
    '--output',
    texPath
  ]);

  logInfo('Compiling LaTeX to PDF (pdflatex)…');
  await runCommand('pdflatex', [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-output-directory',
    TESTS_DIR,
    texPath
  ]);

  // pdflatex generates aux/log/toc files; clean them to avoid noise.
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

async function uploadPdfToS3(pdfPath) {
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
  const keyPrefix = rawPrefix ? `${rawPrefix}/tests` : 'tests';
  const fileName = path.basename(pdfPath);
  const objectKey = `${keyPrefix.replace(/\/+$/, '')}/${fileName}`;
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

async function main() {
  await fsPromises.mkdir(TESTS_DIR, { recursive: true });
  await fsPromises.mkdir(TRACES_DIR, { recursive: true });

  logInfo('Installing dependencies (npm install)…');
  await runCommand('npm', ['install', '--no-audit', '--no-fund']);

  const server = startServer();
  let serverExited = false;
  server.once('exit', () => {
    serverExited = true;
  });

  try {
    await waitForWarmup(server);
    await runBoltonTests();
    await ensurePdflatexAvailable();
    const pdfPath = await generateLatexAndPdf();
    await uploadPdfToS3(pdfPath);
    logInfo('Pipeline completed successfully.');
  } finally {
    if (!serverExited) {
      logInfo('Stopping server…');
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        server.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exitCode = 1;
});
