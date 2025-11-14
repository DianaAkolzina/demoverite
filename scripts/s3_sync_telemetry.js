// Light-weight AWS S3 sync without bundling the AWS SDK (keeps Docker builds leaner).
// Uses SigV4 signing with native crypto + node-fetch to list CSV telemetry files
// and mirror them locally.
//
// Env:
//  - AWS_S3_BUCKET (required)
//  - AWS_S3_REGION or AWS_REGION (default eu-west-2)
//  - AWS_S3_PREFIX (optional)
//  - S3_LOCAL_DIR (default ./CSVex_s3)
//  - AWS_S3_FORCE_PATH_STYLE=1 (optional, force path-style URLs)

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const key = m[1].trim();
    if (!key || process.env[key]) return;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

const REQUIRED_ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

const encodeRfc3986 = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const encodePath = (key = '') => key.split('/').map((seg) => encodeRfc3986(seg)).join('/');

const hashHex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

const decodeXml = (str = '') =>
  str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

function resolveHost(bucket, region, forcePathStyle) {
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

function sign({ method, region, service, host, canonicalUri, query, headers, accessKey, secretKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') + 'Z';
  const dateStamp = amzDate.substring(0, 8);
  headers['x-amz-date'] = amzDate;
  const canonicalHeaders = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}\n`)
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

async function awsFetch({ method, bucket, region, keyPath = '', query = {}, expectBinary = false }) {
  const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === '1';
  const { host, pathPrefix } = resolveHost(bucket, region, forcePathStyle);
  let canonicalUri = pathPrefix || '';
  if (keyPath) {
    canonicalUri += `${canonicalUri ? '/' : '/'}${encodePath(keyPath)}`;
  }
  if (!canonicalUri) canonicalUri = '/';
  const queryString = buildQuery(query);
  const url = `https://${host}${canonicalUri}${queryString ? `?${queryString}` : ''}`;
  const service = 's3';

  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    throw new Error('AWS credentials missing (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)');
  }

  const headers = {
    Host: host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD'
  };
  if (process.env.AWS_SESSION_TOKEN) {
    headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  }
  const { authorization, amzDate } = sign({
    method,
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

  const res = await fetch(url, { method, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`S3 ${method} ${res.status} ${res.statusText}: ${body || 'no body'}`);
  }
  return expectBinary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

function parseListResponse(xml) {
  const keys = [];
  const keyRegex = /<Key>(<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Key>/gi;
  let match;
  while ((match = keyRegex.exec(xml))) {
    keys.push(decodeXml(match[2]));
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/i);
  const nextToken = tokenMatch ? decodeXml(tokenMatch[1]) : undefined;
  return { keys, truncated, nextToken };
}

async function listCsvKeys(bucket, region, prefix) {
  const keys = [];
  let token;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (prefix) query.prefix = prefix;
    if (token) query['continuation-token'] = token;
    const xml = await awsFetch({ method: 'GET', bucket, region, keyPath: '', query });
    const { keys: pageKeys, truncated, nextToken } = parseListResponse(xml);
    for (const key of pageKeys) {
      if (key.endsWith('.csv')) keys.push(key);
    }
    token = truncated && nextToken ? nextToken : undefined;
  } while (token);
  return keys;
}

async function downloadObject(bucket, region, key) {
  return awsFetch({ method: 'GET', bucket, region, keyPath: key, expectBinary: true });
}

async function main() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  const rawPrefix = (process.env.AWS_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const trimmedPrefix = rawPrefix || undefined;
  const outDir = path.resolve(process.cwd(), process.env.S3_LOCAL_DIR || 'CSVex_s3');

  if (!bucket) {
    console.error('[s3-sync] Missing AWS_S3_BUCKET');
    process.exit(2);
  }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`[s3-sync] Missing AWS credentials (${missing.join(', ')})`);
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[s3-sync] Listing s3://${bucket}/${trimmedPrefix ? trimmedPrefix + '/' : ''}`);
  const keys = await listCsvKeys(bucket, region, trimmedPrefix);
  if (!keys.length) {
    console.log('[s3-sync] No CSV objects found');
    return;
  }

  let downloaded = 0;
  const prefixNormalized = trimmedPrefix ? `${trimmedPrefix.replace(/\/+$/, '')}/` : '';
  for (const key of keys) {
    let rel = key;
    if (prefixNormalized && rel.startsWith(prefixNormalized)) rel = rel.slice(prefixNormalized.length);
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    const safeParts = rel.split('/').filter((part) => part && part !== '..');
    if (!safeParts.length) continue;
    const dest = path.join(outDir, ...safeParts);
    const tmp = `${dest}.tmp`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const blob = await downloadObject(bucket, region, key);
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, dest);
    downloaded++;
    console.log(`[s3-sync] wrote ${rel}`);
  }
  const countCsv = (dir) => {
    let totalCount = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        totalCount += countCsv(full);
      } else if (/\.csv$/i.test(entry.name)) {
        totalCount += 1;
      }
    }
    return totalCount;
  };
  const total = countCsv(outDir);
  console.log(`[s3-sync] Done. Downloaded: ${downloaded}, Total local: ${total}`);
}

main().catch((err) => {
  console.error('[s3-sync] Failed:', err?.message || String(err));
  process.exit(1);
});
