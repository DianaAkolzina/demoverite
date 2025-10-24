// Danger: Purge local generated CSV folders.
// Removes contents of ./CSVex and ./csvex_enriched (files only).
import fs from 'fs';
import path from 'path';

function purgeDir(dir) {
  const p = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(p)) return 0;
  let removed = 0;
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, ent.name);
    if (ent.isDirectory()) {
      removed += purgeDir(full);
      try { fs.rmdirSync(full); } catch {}
    } else {
      fs.unlinkSync(full); removed++;
    }
  }
  return removed;
}

const total = purgeDir('CSVex') + purgeDir('csvex_enriched');
console.log(`[purge] Removed ${total} local files under CSVex/ and csvex_enriched/`);

