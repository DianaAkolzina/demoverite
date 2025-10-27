// Simple S3 -> local mirror for device telemetry CSVs.
// Env:
//  - AWS_S3_BUCKET (required)
//  - AWS_S3_REGION or AWS_REGION (default eu-west-2)
//  - AWS_S3_PREFIX (optional)
//  - S3_LOCAL_DIR (default ./CSVex_s3)

import fs from 'fs';
import path from 'path';

async function main() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  const rawPrefix = (process.env.AWS_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const prefix = rawPrefix ? (rawPrefix + '/') : '';
  const outDir = path.resolve(process.cwd(), process.env.S3_LOCAL_DIR || 'CSVex_s3');
  if (!bucket) { console.error('[s3-sync] Missing AWS_S3_BUCKET'); process.exit(2); }
  const mod = await import('@aws-sdk/client-s3').catch(() => null);
  if (!mod) { console.error('[s3-sync] @aws-sdk/client-s3 not installed'); process.exit(2); }
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = mod;
  const credentials = (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined;
  const s3 = new S3Client({ region, credentials });
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[s3-sync] Listing s3://${bucket}/${prefix || ''} ...`);
  let token = undefined; const remote = [];
  while (true) {
    const params = { Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 };
    if (rawPrefix) params.Prefix = rawPrefix;
    const res = await s3.send(new ListObjectsV2Command(params));
    for (const o of (res.Contents || [])) {
      const key = o.Key || '';
      if (!key.endsWith('.csv')) continue;
      remote.push(key);
    }
    if (!res.IsTruncated) break; token = res.NextContinuationToken;
  }
  let downloaded = 0;
  for (const key of remote) {
    const fname = key.slice(key.lastIndexOf('/') + 1);
    const dest = path.join(outDir, fname);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await obj.Body?.transformToByteArray?.();
    if (!buf) continue;
    fs.writeFileSync(dest + '.tmp', Buffer.from(buf)); fs.renameSync(dest + '.tmp', dest);
    downloaded++;
    console.log('[s3-sync] wrote', fname);
  }
  console.log(`[s3-sync] Done. Downloaded: ${downloaded}, Total local: ${fs.readdirSync(outDir).filter(f=>f.endsWith('.csv')).length}`);
}

main().catch(e => { console.error('[s3-sync] Failed:', e?.message || String(e)); process.exit(1); });

