/**
 * The setup primitives. Each exists because the obvious version of it was
 * WRONG on a real machine, silently.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { onPersistedPath, classifyEndpoint, writeVerified, appendVerified } from '../src/setup.js';

describe('onPersistedPath: the process PATH is not the real PATH', () => {
  const user = 'C:\\Users\\x\\AppData\\Roaming\\npm;C:\\Users\\x\\.local\\bin';
  const machine = 'C:\\Windows\\System32';

  test('finds an entry that is present', () => {
    assert.equal(onPersistedPath('C:\\Users\\x\\AppData\\Roaming\\npm', machine, user), true);
  });

  test('does NOT find one that is only in this process', () => {
    // The exact 2026-08-21 defect: a bin dir was on $env:PATH in the installing
    // session and in NEITHER persisted value, so the shim resolved for the
    // installer and for nobody else -- and the omnibox, whose guard is a
    // SilentlyContinue Get-Command, fell back to the ordinary error.
    assert.equal(onPersistedPath('C:\\Users\\x\\bin', machine, user), false);
  });

  test('ignores a trailing separator and case', () => {
    assert.equal(onPersistedPath('c:\\users\\x\\.local\\bin\\', machine, user), true);
  });
});

describe('classifyEndpoint: three different answers all look "up"', () => {
  test('an HTML body is a placeholder host, never an inference route', () => {
    // This one renders as "(no response)" with no reason, which is the worst of
    // the three because it looks like the model chose to say nothing.
    assert.equal(classifyEndpoint(200, 'text/html; charset=utf-8'), 'html');
  });

  test('a refusal means the route EXISTS and is enforcing', () => {
    for (const s of [400, 401, 403, 422]) {
      assert.equal(classifyEndpoint(s, 'application/json'), 'ok', 'status ' + s);
    }
  });

  test('a bare 200 to an UNAUTHENTICATED chat POST is wrong, not healthy', () => {
    // A real /v1 refuses an unauthenticated call. A 200 means something else is
    // answering -- treating it as success is how a placeholder gets adopted.
    assert.equal(classifyEndpoint(200, 'application/json'), 'wrong');
  });
});

describe('writeVerified / appendVerified: a write that returns is not a write', () => {
  test('confirms content by reading it back', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'awsh-set-')), 'a.txt');
    assert.equal(writeVerified(f, 'hello'), true);
    assert.equal(readFileSync(f, 'utf-8'), 'hello');
  });

  test('reports false when the target cannot be written', () => {
    // Stands in for Controlled Folder Access, which fails a CREATE as
    // "Could not find file" and makes Add-Content report success.
    assert.equal(writeVerified(join(tmpdir(), 'no-such-dir-awsh', 'a.txt'), 'x'), false);
  });

  test('append is idempotent on the marker', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'awsh-set-')), 'p.ps1');
    writeFileSync(f, '# existing' + String.fromCharCode(10), 'utf-8');
    const marker = '# >>> awsh omnibox >>>';
    const block = marker + String.fromCharCode(10) + '. thing' + String.fromCharCode(10);
    assert.equal(appendVerified(f, marker, block), true);
    const once = readFileSync(f, 'utf-8');
    assert.equal(appendVerified(f, marker, block), true, 'second call must succeed');
    assert.equal(readFileSync(f, 'utf-8'), once, 'the second call appended again');
    assert.match(once, /# existing/, 'the pre-existing content was destroyed');
  });
});
