/**
 * update-check.ts: awsh's once-a-day npm registry check. awsh had none; these pin
 * the registry target, the cache and once-a-day notice, the opt-outs, the
 * per-install-method upgrade command, and that the startup hook never waits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CHILD_SCRIPT, CHECK_INTERVAL_MS, REGISTRY_URL, checkForUpdate, detectInstallMethod, isNewer,
  readCache, updateCheckDisabled, upgradeCommand,
} from '../src/update-check.js';

function tmp(): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-update-'));
  return {
    file: join(dir, '.aither', 'update-check-awsh.json'),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('registry target is @aitherium/awsh latest', () => {
  assert.equal(REGISTRY_URL, 'https://registry.npmjs.org/@aitherium%2Fawsh/latest');
});

test('isNewer: strictly newer only, never a downgrade', () => {
  assert.equal(isNewer('1.19.5', '1.19.4'), true);
  assert.equal(isNewer('1.20.0', '1.19.9'), true);
  assert.equal(isNewer('1.19.4', '1.19.4'), false);
  assert.equal(isNewer('1.19.3', '1.19.4'), false);
  assert.equal(isNewer('1.19.5', '0.0.0-unknown'), true);
  assert.equal(isNewer('', '1.0.0'), false);
});

test('opt-outs: AWSH_NO_UPDATE_CHECK, AITHER_NO_UPDATE_CHECK, offline', () => {
  assert.equal(updateCheckDisabled({}, false), false);
  assert.equal(updateCheckDisabled({ AWSH_NO_UPDATE_CHECK: '1' }, false), true);
  assert.equal(updateCheckDisabled({ AITHER_NO_UPDATE_CHECK: 'true' }, false), true);
  assert.equal(updateCheckDisabled({ AWSH_NO_UPDATE_CHECK: '0' }, false), false);
  assert.equal(updateCheckDisabled({}, true), true);
});

test('install method from where the script and runtime live', () => {
  const d = (scriptPath: string, execPath = '/usr/bin/node', compiled = false) =>
    detectInstallMethod({ scriptPath, execPath, compiled });
  assert.equal(d(String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@aitherium\awsh\dist\main.js`), 'npm');
  assert.equal(d('/usr/local/lib/node_modules/@aitherium/awsh/dist/main.js'), 'npm');
  assert.equal(d('/home/u/.local/share/pnpm/global/5/node_modules/@aitherium/awsh/dist/main.js'), 'pnpm');
  assert.equal(d('/home/u/.bun/install/global/node_modules/@aitherium/awsh/dist/main.js'), 'bun');
  assert.equal(d('/home/u/.config/yarn/global/node_modules/@aitherium/awsh/dist/main.js'), 'yarn');
  assert.equal(d('/src/AitherOS/.PRODUCTS/.AITHERSHELL/cli/src/main.ts'), 'source');
  assert.equal(d('/$bunfs/root/aither-shell', '/opt/homebrew/Cellar/awsh/1.19.4/bin/awsh', true), 'brew');
  assert.equal(d('B:/~BUN/root/x',
    String.raw`C:\Users\u\AppData\Local\Microsoft\WinGet\Packages\Aitherium.AitherShell\aither-shell-win64.exe`, true), 'winget');
  assert.equal(d('/$bunfs/root/x', '/home/u/bin/aither-shell-linux-x64', true), 'binary');
});

test('upgrade command per install method', () => {
  assert.equal(upgradeCommand('npm', '1.20.0'), 'npm i -g @aitherium/awsh@latest');
  assert.equal(upgradeCommand('pnpm', '1.20.0'), 'pnpm add -g @aitherium/awsh@latest');
  assert.equal(upgradeCommand('bun', '1.20.0'), 'bun add -g @aitherium/awsh@latest');
  assert.equal(upgradeCommand('brew', '1.20.0'), 'brew upgrade awsh');
  assert.equal(upgradeCommand('winget', '1.20.0'), 'winget upgrade Aitherium.AitherShell');
  assert.match(upgradeCommand('binary', '1.20.0')!, /shell-v1\.20\.0/);
  assert.equal(upgradeCommand('source', '1.20.0'), null);
});

test('no cache: refreshes in the background, no notice yet, cached for next start', async () => {
  const t = tmp();
  try {
    let calls = 0;
    const fetcher = async () => { calls++; return '1.20.0'; };
    const r = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file, fetcher });
    assert.equal(r.notice, null);
    await r.refresh;
    assert.equal(calls, 1);
    assert.equal(readCache(t.file)?.latest, '1.20.0');

    const next = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file, fetcher });
    assert.equal(next.notice,
      'awsh 1.20.0 is available (you have 1.19.4). Update: npm i -g @aitherium/awsh@latest');
    assert.equal(next.refresh, undefined, 'a fresh cache must not look the registry up again');
    assert.equal(calls, 1);

    const third = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file, fetcher });
    assert.equal(third.notice, null, 'the notice prints at most once a day');

    const later = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file,
      now: Date.now() + CHECK_INTERVAL_MS + 1000, fetcher });
    assert.ok(later.notice, 'and again the next day');
    assert.ok(later.refresh, 'with a fresh lookup the next day');
    await later.refresh;
  } finally {
    t.done();
  }
});

test('no notice when up to date, ahead of npm, or a source checkout', () => {
  const t = tmp();
  try {
    mkdirSync(dirname(t.file), { recursive: true });
    const seed = (latest: string) =>
      writeFileSync(t.file, JSON.stringify({ latest, checkedAt: Date.now() }));
    seed('1.19.4');
    assert.equal(checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file }).notice, null);
    assert.equal(checkForUpdate({ current: '1.20.0', method: 'npm', cacheFile: t.file }).notice, null);
    seed('9.0.0');
    assert.equal(checkForUpdate({ current: '1.19.4', method: 'source', cacheFile: t.file }).notice, null);
  } finally {
    t.done();
  }
});

test('the startup hook never waits on a slow registry, and failure is silent', async () => {
  const t = tmp();
  try {
    const t0 = Date.now();
    const r = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file,
      fetcher: () => new Promise((res) => setTimeout(() => res(null), 300)) });
    assert.ok(Date.now() - t0 < 100);
    assert.equal(r.notice, null);
    await r.refresh;
    assert.equal(readCache(t.file)?.latest, '', 'a failed lookup records no version');
    let calls = 0;
    const r2 = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file,
      fetcher: async () => { calls++; throw new Error('offline'); } });
    assert.equal(r2.refresh, undefined, 'a failed lookup is not retried on every command');
    assert.equal(calls, 0);
    const r3 = checkForUpdate({ current: '1.19.4', method: 'npm', cacheFile: t.file,
      now: Date.now() + CHECK_INTERVAL_MS + 1000,
      fetcher: async () => { calls++; throw new Error('offline'); } });
    await r3.refresh;
    assert.equal(calls, 1, 'but is retried the next day');
    assert.equal(r3.notice, null);
  } finally {
    t.done();
  }
});

test('the detached lookup script runs under node -e and fails quietly', () => {
  const t = tmp();
  try {
    // Port 1 on loopback refuses at once: the script must exit 0 and write nothing.
    const r = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, 'https://127.0.0.1:1/x', t.file],
      { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(readCache(t.file), null);
  } finally {
    t.done();
  }
});

test('the detached lookup script writes latest/checkedAt and keeps the other fields', async () => {
  const t = tmp();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: '@aitherium/awsh', version: '9.9.9' }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(t.file), { recursive: true });
    writeFileSync(t.file, JSON.stringify({ latest: '1.0.0', checkedAt: 1, notifiedAt: 2, attemptedAt: 3 }));
    const before = Date.now();
    // Async spawn: spawnSync would block this process's server from answering.
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, `http://127.0.0.1:${port}/x`, t.file],
        { stdio: 'ignore' });
      child.on('exit', resolve);
    });
    assert.equal(code, 0);
    const c = readCache(t.file);
    assert.ok(c);
    assert.equal(c.latest, '9.9.9');
    assert.ok(c.checkedAt >= before);
    assert.equal(c.notifiedAt, 2);
    assert.equal(c.attemptedAt, 3);
  } finally {
    server.close();
    t.done();
  }
});
