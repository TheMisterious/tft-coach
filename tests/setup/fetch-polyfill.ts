// Vitest runs in Node with no browser fetch. src/enrichment/meta-lookup.ts's
// loadMeta() calls fetch('/data/sets/set17/champions.json', ...) — real paths
// that only resolve in the actual app, where webpack/Overwolf serve /data/*
// off the project root. This polyfill maps those same absolute paths straight
// to the filesystem so tests exercise the real loadMeta() code path instead of
// needing a second, test-only meta-loading function to stay in sync with it.

import { readFileSync, existsSync } from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

(globalThis as any).fetch = async (url: string) => {
  const filePath = path.join(PROJECT_ROOT, url.replace(/^\/+/, ''));

  if (!existsSync(filePath)) {
    return { ok: false, status: 404 } as Response;
  }

  const content = readFileSync(filePath, 'utf-8');
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(content),
  } as Response;
};
