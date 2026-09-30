/**
 * Offline covers the egress paths outside the backend ladder: the identity lookup behind
 * `awsh whoami` keeps its bearer on loopback hosts, and the crash reporter sends nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityBases } from '../src/auth.js';
import { crashReportAllowed } from '../src/crash-reporter.js';
import { isLoopbackUrl, shellIsOffline } from '../src/offline.js';

test('identityBases offline: loopback only, never api.aitherium.com', () => {
  const online = identityBases(false);
  assert.ok(online.includes('https://api.aitherium.com'));
  const offline = identityBases(true);
  assert.ok(offline.length > 0);
  assert.ok(offline.every(isLoopbackUrl), offline.join(', '));
});

test('crash reporter: refused offline (env), allowed online', () => {
  const home = mkdtempSync(join(tmpdir(), 'awsh-egress-'));
  try {
    assert.equal(crashReportAllowed({ AITHER_OFFLINE: '1' }, { home, root: home }), false);
    assert.equal(crashReportAllowed({ AITHER_OFFLINE: '0' }, { home, root: home }), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('shellIsOffline reads the vendor layer when the environment is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'awsh-egress-root-'));
  try {
    mkdirSync(join(root, 'usr', 'lib', 'awsh'), { recursive: true });
    writeFileSync(join(root, 'usr', 'lib', 'awsh', 'shell.yaml'), 'offline: true\r\n');
    assert.equal(shellIsOffline({}, { home: root, root }), true);
    assert.equal(crashReportAllowed({}, { home: root, root }), false);
    assert.equal(shellIsOffline({ AITHER_OFFLINE: '0' }, { home: root, root }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
