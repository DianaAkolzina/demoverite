#!/usr/bin/env node
/**
 * Upload local report PDFs to S3 using SigV4.
 *
 * Usage:
 *   node scripts/upload_reports_to_s3.js --file data/traces_report.pdf --label manual
 *
 * If --file is omitted, defaults to data/traces_report.pdf.
 * The object key is tests/<label>/<timestamp>_<basename>.pdf (label defaults to "reports").
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { file: null, label: 'reports' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') {
      out.file = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      out.file = arg.split('=')[1];
    } else if (arg === '--label') {
      out.label = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--label=')) {
      out.label = arg.split('=')[1];
    }
  }
  if (!out.file) {
    out.file = path.join('data', 'traces_report.pdf');
  }
  return out;
}

async function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match) return;
      const key = match[1].trim();
      const value = match[2];
      if (key && process.env[key] == null) {
        process.env[key] = value;
      }
    });
  } catch {
    // ignore missing .env
  }
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

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function uploadPdf({ filePath, label }) {
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
  const baseName = path.basename(filePath);
  const fileName = `${timestamp}_${baseName}`;
  const objectKey = `${keyRoot}/${label}/${fileName}`;
  const fileBuffer = await fs.readFile(filePath);
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

  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: fileBuffer
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText} ${text}`);
  }
  console.log(`[upload] Uploaded ${filePath} → s3://${bucket}/${objectKey}`);
}

async function main() {
  await loadEnvFile();

  const args = parseArgs(process.argv);
  const absolute = path.isAbsolute(args.file) ? args.file : path.join(ROOT, args.file);

  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`File not found: ${absolute}`);
  }

  await uploadPdf({ filePath: absolute, label: args.label || 'reports' });
}

main().catch((err) => {
  console.error(`[upload] ERROR: ${err.message || err}`);
  process.exitCode = 1;
});
