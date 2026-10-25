// `awsh setup` must never pin a REMOTE endpoint into ~/.aither/shell.yaml.
// 2026-10-25: a setup run while the daemon was down wrote
// `api_url: https://mcp.aitherium.com`; the pin disabled the backend ladder, and every
// omnibox line went to the gateway's tool-less chat ("no direct way to fetch current
// news") while the local daemon sat healthy with web_search registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf-8');

test('setup checks the endpoint is private before persisting api_url', () => {
  const guard = src.indexOf('!_isPrivateHost(ep.url)');
  const write = src.indexOf("'api_url: ' + ep.url");
  assert.ok(guard > 0, 'the remote-endpoint guard is gone');
  assert.ok(write > 0, 'the api_url write moved; re-pin this test');
  assert.ok(guard < write, 'the guard must come before the write');
});
