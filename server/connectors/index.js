import fs from 'fs';
import path from 'path';
import { createGraphFromEnv } from '../graph.js';
import { createVectorClient } from '../vector.js';
import { Connector, ConnectorRegistry } from './base.js';

export function initConnectorRegistry({ root, env = process.env } = {}) {
  const registry = new ConnectorRegistry();

  const graphConnector = new Connector({
    id: 'neo4j',
    label: 'Neo4j Graph',
    description: 'Owner/shop topology and relationships.',
    check: async () => {
      const graph = createGraphFromEnv(env);
      if (!graph?.ping) {
        return { status: 'error', detail: 'Graph adapter unavailable' };
      }
      const started = Date.now();
      const result = await graph.ping();
      const latencyMs = Date.now() - started;
      if (result?.ok) {
        return { status: 'ok', metadata: { latencyMs } };
      }
      return { status: 'error', detail: result?.error || 'Ping failed', metadata: { latencyMs } };
    }
  });

  const vectorConnector = new Connector({
    id: 'chroma',
    label: 'Chroma Vector',
    description: 'Embedding store for knowledge grounding.',
    check: async () => {
      try {
        const vector = await createVectorClient(env);
        if (!vector?.ping) return { status: 'degraded', detail: 'Vector client missing ping()' };
        const started = Date.now();
        const ok = await vector.ping();
        const latencyMs = Date.now() - started;
        return ok
          ? { status: 'ok', metadata: { latencyMs } }
          : { status: 'degraded', detail: 'Vector ping failed', metadata: { latencyMs } };
      } catch (err) {
        return { status: 'error', detail: err?.message || String(err) };
      }
    }
  });

  const telemetryConnector = new Connector({
    id: 'telemetry',
    label: 'Telemetry Cache',
    description: 'CSVex_s3 mirror and cached product tables.',
    check: async () => {
      try {
        const dir = path.join(root || process.cwd(), env.S3_LOCAL_DIR || 'CSVex_s3');
        if (!fs.existsSync(dir)) {
          return { status: 'degraded', detail: `Missing directory ${dir}` };
        }
        const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
        return {
          status: files.length ? 'ok' : 'degraded',
          metadata: { files: files.length }
        };
      } catch (err) {
        return { status: 'error', detail: err?.message || String(err) };
      }
    }
  });

  const weatherConnector = new Connector({
    id: 'weather',
    label: 'Market Signals Cache',
    description: 'Cached market signal series in data/weather_buildings.',
    check: async () => {
      try {
        const dir = path.join(root || process.cwd(), 'data', 'weather_buildings');
        if (!fs.existsSync(dir)) {
          return { status: 'degraded', detail: `Missing ${dir}` };
        }
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.csv'));
        if (!files.length) {
          return { status: 'degraded', detail: 'No cached weather files' };
        }
        return { status: 'ok', metadata: { files: files.length } };
      } catch (err) {
        return { status: 'error', detail: err?.message || String(err) };
      }
    }
  });

  registry.register(graphConnector);
  registry.register(vectorConnector);
  registry.register(telemetryConnector);
  registry.register(weatherConnector);

  registry.refresh({ force: true }).catch((err) => {
    console.warn('[connectors] initial refresh failed:', err?.message || err);
  });

  return registry;
}
