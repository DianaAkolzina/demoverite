// Sync all device telemetry CSVs from S3 to a local folder.
// Env:
//  - AWS_S3_BUCKET (required)
//  - AWS_S3_REGION (default eu-west-2)
//  - AWS_S3_PREFIX (required) e.g., digispace_backup_24_10_2025
//  - S3_LOCAL_DIR (default ./CSVex_s3)
//  - AWS credentials via env or default provider chain

import fs from 'fs';
import path from 'path';

// Load .env from repo root if present (simple parser; respects existing env)
try {
  const root = process.cwd();
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const key = m[1].trim();
        if (process.env[key] == null || process.env[key] === '') {
          process.env[key] = m[2];
        }
      }
    });
  }
} catch {}

async function main() {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_S3_REGION || process.env.AWS_REGION || 'eu-west-2';
  const rawPrefix = (process.env.AWS_S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const prefix = rawPrefix ? (rawPrefix + '/') : '';
  const outDir = path.resolve(process.cwd(), process.env.S3_LOCAL_DIR || 'CSVex_s3');
  if (!bucket) {
    console.error('[s3-sync] Missing AWS_S3_BUCKET');
    process.exit(2);
  }
  const mod = await import('@aws-sdk/client-s3').catch(() => null);
  if (!mod) {
    console.error('[s3-sync] @aws-sdk/client-s3 not installed. Run: npm i @aws-sdk/client-s3');
    process.exit(2);
  }
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = mod;
  const s3 = new S3Client({ region });
  fs.mkdirSync(outDir, { recursive: true });
  // Build set of remote keys and download
  let token = undefined; const remote = new Set(); let downloaded = 0;
  console.log(`[s3-sync] Listing s3://${bucket}/${prefix || ''} ...`);
  while (true) {
    const params = { Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 };
    if (rawPrefix) params.Prefix = rawPrefix;
    const res = await s3.send(new ListObjectsV2Command(params));
    for (const o of (res.Contents || [])) {
      const key = o.Key || '';
      if (!key.endsWith('.csv')) continue;
      remote.add(key);
      const fname = key.slice(key.lastIndexOf('/') + 1);
      const dest = path.join(outDir, fname);
      let need = true;
      try {
        const st = fs.statSync(dest);
        if (st.size === Number(o.Size || 0)) need = false;
      } catch {}
      if (need) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const buf = await obj.Body?.transformToByteArray?.();
        if (buf) { fs.writeFileSync(dest + '.tmp', Buffer.from(buf)); fs.renameSync(dest + '.tmp', dest); downloaded++; }
        console.log('[s3-sync] downloaded', fname);
      }
    }
    if (!res.IsTruncated) break; token = res.NextContinuationToken;
  }
  // Cleanup extraneous local files
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.csv'));
  let removed = 0;
  // Compare by basename to avoid requiring exact prefix match
  const remoteBase = new Set(Array.from(remote).map(k => k.slice(k.lastIndexOf('/') + 1)));
  for (const f of files) {
    const full = path.join(outDir, f);
    if (!remoteBase.has(f)) { fs.unlinkSync(full); removed++; }
  }
  console.log(`[s3-sync] Done. Downloaded: ${downloaded}, Removed: ${removed}, Total local: ${fs.readdirSync(outDir).filter(f=>f.endsWith('.csv')).length}`);
}

main().catch(e => { console.error('[s3-sync] Failed:', e); process.exit(1); });
