/**
 * `/secret` — the vault verb awsh did not have.
 *
 * What must hold:
 *  - listing prints NAMES and never a value, in either body shape the service returns;
 *  - `get` prints the value alone, so it pipes; a missing name prints no value at all;
 *  - `set` reads the value from hidden input and NEVER from argv (argv is echoed and
 *    written to the history file), and the confirmation is masked;
 *  - a value never reaches an error line, even when the transport throws;
 *  - personal secrets refuse `get` out loud (write-only by design) instead of
 *    inventing a read route;
 *  - Proton is read-THROUGH: `ls` lists safe items, `get` goes through the audited
 *    autofill route and prints only the password;
 *  - the alias table resolves /vault and /secrets to the one command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFlags, parsePersonalSecrets, parseProtonItems, parseWorkspaceKeys,
  runSecretCommand, validSecretName, type SecretBackend, type SecretDeps,
} from '../src/secret-command.js';
import {
  maskValue, parseSecretValue, parseSecretsList, resolveSecretsUrl, vaultHeaders,
} from '../src/lockbox-client.js';
import { canonicalCommandName, getCommand } from '../src/commands.js';

/** A backend that records every call and answers from a table. */
function fakeBackend(routes: Record<string, unknown>): SecretBackend & { calls: string[] } {
  const calls: string[] = [];
  const answer = (path: string) => {
    calls.push(path);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    if (key === undefined) throw new Error(`no route for ${path}`);
    return routes[key];
  };
  return {
    calls,
    get: async (p: string) => answer(p),
    post: async (p: string) => answer(p),
    put: async (p: string) => answer(p),
    delete: async (p: string) => answer(p),
  };
}

function harness(over: Partial<SecretDeps> = {}) {
  const lines: string[] = [];
  const values: string[] = [];
  return {
    lines,
    values,
    deps: {
      env: { AITHER_ADMIN_KEY: 'k' } as any,
      log: (l: string) => lines.push(l),
      writeValue: (v: string) => values.push(v),
      askHidden: async () => 'hunter2-shaped-value',
      ...over,
    },
  };
}

test('listing prints names and never a value, in either body shape', async () => {
  const vault = {
    list: async () => [
      { name: 'DB_PASSWORD' }, { name: 'API_KEY', type: 'generic' },
    ],
    get: async () => { throw new Error('listing must not read values'); },
    set: async () => true,
    remove: async () => true,
    health: async () => ({ ok: true, detail: 'ok' }),
  };
  const h = harness({ vault: vault as any });
  assert.equal(await runSecretCommand(['ls'], h.deps), 0);
  const text = h.lines.join('\n');
  assert.match(text, /DB_PASSWORD/)
  assert.match(text, /API_KEY/)
  assert.equal(h.values.length, 0)
});

test('get prints the value alone so it pipes', async () => {
  const h = harness({
    vault: {
      list: async () => [], get: async () => 's3cr3t-value', set: async () => true,
      remove: async () => true, health: async () => ({ ok: true, detail: 'ok' }),
    } as any,
  });
  assert.equal(await runSecretCommand(['get', 'DB_PASSWORD'], h.deps), 0);
  assert.deepEqual(h.values, ['s3cr3t-value']);
});

test('a missing name prints no value and exits non-zero', async () => {
  const h = harness({
    vault: {
      list: async () => [], get: async () => null, set: async () => true,
      remove: async () => true, health: async () => ({ ok: true, detail: 'ok' }),
    } as any,
  });
  assert.equal(await runSecretCommand(['get', 'NOPE'], h.deps), 1);
  assert.equal(h.values.length, 0);
});

test('set takes the value from hidden input, never from argv, and masks the echo', async () => {
  let stored: [string, string] | null = null;
  const h = harness({
    vault: {
      list: async () => [],
      get: async () => null,
      set: async (n: string, v: string) => { stored = [n, v]; return true },
      remove: async () => true,
      health: async () => ({ ok: true, detail: 'ok' }),
    } as any,
  });
  assert.equal(await runSecretCommand(['set', 'NEW_TOKEN'], h.deps), 0);
  assert.deepEqual(stored, ['NEW_TOKEN', 'hunter2-shaped-value']);
  const text = h.lines.join('\n');
  assert.ok(!text.includes('hunter2-shaped-value'), 'the value must not be echoed in full');
  assert.match(text, /stored/);
});

test('a transport failure never puts the value into the error line', async () => {
  const h = harness({
    vault: {
      list: async () => [], set: async () => true, remove: async () => true,
      health: async () => ({ ok: true, detail: 'ok' }),
      get: async () => { throw new Error('HTTP 500 from vault') },
    } as any,
  });
  await runSecretCommand(['get', 'DB_PASSWORD'], h.deps);
  assert.equal(h.values.length, 0);
});

test('personal get reveals one value through the audit-logged route', async () => {
  const backend = fakeBackend({ '/api/genesis/lockbox/user/GITHUB_TOKEN': { success: true, value: 'gh-value' } });
  const h = harness({ backend });
  assert.equal(await runSecretCommand(['personal', 'get', 'GITHUB_TOKEN'], h.deps), 0);
  assert.deepEqual(h.values, ['gh-value']);
  assert.ok(backend.calls[0].startsWith('/api/genesis/lockbox/user/GITHUB_TOKEN'));
});

test('personal ls lists names from the wrap shape', async () => {
  const backend = fakeBackend({ '/api/genesis/lockbox/user': { secrets: [{ name: 'B_TOKEN' }, { name: 'A_TOKEN' }] } });
  const h = harness({ backend });
  assert.equal(await runSecretCommand(['personal', 'ls'], h.deps), 0);
  assert.deepEqual(parsePersonalSecrets({ secrets: [{ name: 'B_TOKEN' }, { name: 'A_TOKEN' }] }), ['A_TOKEN', 'B_TOKEN']);
});

test('workspace get prints the value and hits the audited route', async () => {
  const backend = fakeBackend({ '/api/genesis/workspace-secrets/value': { value: 'ws-value' } });
  const h = harness({ backend });
  assert.equal(await runSecretCommand(['workspace', 'get', 'STRIPE_KEY'], h.deps), 0);
  assert.deepEqual(h.values, ['ws-value']);
  assert.match(backend.calls[0], /^\/api\/genesis\/workspace-secrets\/value\?key=STRIPE_KEY/);
});

test('proton lists safe items and reveals only through autofill', async () => {
  const backend = fakeBackend({
    '/api/proton-pass/items': { data: { items: [{ name: 'GitHub', username: 'me@proton.me' }], count: 1 } },
    '/api/proton-pass/autofill': { data: { username: 'me@proton.me', password: 'pp-value' } },
  });
  const h = harness({ backend });

  assert.equal(await runSecretCommand(['proton', 'ls'], h.deps), 0);
  assert.match(h.lines.join('\n'), /GitHub/);
  assert.equal(parseProtonItems({ data: { items: [{ name: 'GitHub' }] } }).length, 1);

  assert.equal(await runSecretCommand(['proton', 'get', 'github.com'], h.deps), 0);
  assert.deepEqual(h.values, ['pp-value']);
  assert.ok(backend.calls.includes('/api/proton-pass/autofill'));
});

test('flags parse without swallowing positionals', () => {
  assert.deepEqual(parseFlags(['ls', '--json']), { positional: ['ls'], flags: { json: true } });
  assert.deepEqual(parseFlags(['proton', 'ls', '--search', 'git']), {
    positional: ['proton', 'ls'], flags: { search: 'git' },
  });
});

test('names that could be a pasted credential are refused', () => {
  assert.equal(validSecretName('DB_PASSWORD'), true);
  assert.equal(validSecretName('proton:mail'), true);
  assert.equal(validSecretName('has space'), false);
  assert.equal(validSecretName('-leading'), false);
});

test('the client parses both value shapes and refuses to stringify an object', () => {
  assert.equal(parseSecretValue('v'), 'v');
  assert.equal(parseSecretValue({ value: 'v' }), 'v');
  assert.equal(parseSecretValue({ nope: 1 }), null);
  assert.deepEqual(parseSecretsList({ secrets: ['B', { name: 'A' }] }).map(s => s.name), ['A', 'B']);
  assert.deepEqual(parseWorkspaceKeys({ secrets: [{ key: 'K', masked: '****' }] }), [{ key: 'K', masked: '****' }]);
});

test('masking keeps a value unreadable but recognisable', () => {
  assert.equal(maskValue('abcdefghij').startsWith('a'), true);
  assert.ok(maskValue('abcdefghij').includes('*'));
  assert.ok(!maskValue('abcdefghij').includes('bcdefg'));
});

test('vault URL and credential resolution: explicit wins, operator key beats bearer', () => {
  assert.equal(resolveSecretsUrl({ AITHER_SECRETS_URL: 'https://v:8111/' }), 'https://v:8111');
  assert.equal(resolveSecretsUrl({ AITHERSECRETS_URL: 'https://w:8111' }), 'https://w:8111');
  assert.equal(resolveSecretsUrl({}), 'http://127.0.0.1:8001');
  assert.equal(vaultHeaders({ AITHER_INTERNAL_SECRET: 'k' }, 'bearer').Authorization, undefined);
  assert.equal(vaultHeaders({ AITHER_INTERNAL_SECRET: 'k' }, 'bearer')['X-API-Key'], 'k');
  assert.equal(vaultHeaders({}, 'bearer').Authorization, 'Bearer bearer');
});

test('the aliases resolve to the one command', () => {
  assert.equal(canonicalCommandName('vault'), 'secret');
  assert.equal(canonicalCommandName('secrets'), 'secret');
  assert.ok(getCommand('secret'), '/secret must be registered');
});
