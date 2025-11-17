import fs from 'fs';
import path from 'path';
import { buildDocsFromData, buildRagIndex } from '../rag.js';

export function createRagManager({
  dataDir,
  knowledgeDir,
  listRooms,
  loadRoomTables,
  log,
  debug = false
}) {
  const csvDir = path.join(path.dirname(dataDir), 'CSVex_s3');

  const fingerprintSources = () => {
    const targets = [knowledgeDir, dataDir, csvDir];
    const bits = [];
    for (const target of targets) {
      try {
        if (!target) continue;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          const sample = fs.readdirSync(target, { withFileTypes: true }).slice(0, 32);
          bits.push(`${target}:dir:${stat.mtimeMs}:${stat.size}:${sample.length}`);
        } else {
          bits.push(`${target}:file:${stat.mtimeMs}:${stat.size}`);
        }
      } catch {
        bits.push(`${target || 'unknown'}:missing`);
      }
    }
    return bits.join('|');
  };

  let state = { docs: [], index: null, signature: null };

  const rebuild = (reason = 'manual') => {
    const rooms = listRooms();
    const docs = buildDocsFromData({ dataDir, rooms, loadRoomTables, knowledgeDir });
    const index = buildRagIndex(docs, { debug });
    state = { docs, index, signature: fingerprintSources() };
    log(`[RAG] rebuilt (${docs.length} docs) reason=${reason}`);
    return state;
  };

  const ensure = () => {
    const sig = fingerprintSources();
    if (!state.index || state.signature !== sig) return rebuild('auto');
    return state;
  };

  return {
    ensure,
    rebuild,
    stats: () => ({ docs: state.docs.length })
  };
}
