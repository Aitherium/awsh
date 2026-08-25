/**
 * Pack discovery must not depend on a pointer that goes stale.
 *
 * MEASURED 2026-08-21. A shell profile still exported AITHEROS_ROOT pointing at
 * a tree on a drive long since demoted to bulk data. awsh listed 12 packs from
 * there and showed NONE of the 82 sitting beside the code it was executing, so
 * typing a real pack name (`gobbonet`) fell through to the agent, which replied
 * "It appears to be a typo. The intended command might have been go."
 *
 * Nothing looked broken: the list rendered, every pack it named was real, and
 * the missing ones were simply absent -- the same silence as an unset feature.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { packRoots, discoverPacks, findPack, isUsable } from '../src/packs.js';

describe('packRoots: a stale root must not hide packs that exist', () => {
  test('includes a root derived from this module, not only the caller', () => {
    // The decisive property: given a root with no packs at all, the list is
    // still non-empty, because the tree awsh was built from is always consulted.
    const roots = packRoots(join(tmpdir(), 'definitely-not-a-checkout'));
    assert.ok(roots.length >= 2, 'only the caller-supplied root was searched');
  });

  test('AWSH_PACKS_DIR is honoured and comes first', () => {
    const prev = process.env.AWSH_PACKS_DIR;
    process.env.AWSH_PACKS_DIR = join(tmpdir(), 'explicit-packs');
    try {
      assert.equal(packRoots(tmpdir())[0], join(tmpdir(), 'explicit-packs'),
        'an explicit override must win -- it is the only way to be unambiguous');
    } finally {
      if (prev === undefined) delete process.env.AWSH_PACKS_DIR;
      else process.env.AWSH_PACKS_DIR = prev;
    }
  });

  test('roots are deduped, so one tree is never scanned twice', () => {
    const roots = packRoots(tmpdir());
    assert.equal(new Set(roots).size, roots.length);
  });

  test('a pack in the explicit dir is discovered and launchable', () => {
    // Proves the union actually FINDS things, not merely that it lists paths.
    // A roots list that points nowhere passes every test above.
    const dir = mkdtempSync(join(tmpdir(), 'awsh-packs-'));
    mkdirSync(join(dir, 'demopack'));
    writeFileSync(join(dir, 'demopack', 'brain_pack.yaml'),
      'app_name: Demo Pack' + String.fromCharCode(10) +
      'system_prompt: you are a demo' + String.fromCharCode(10), 'utf-8');
    const prev = process.env.AWSH_PACKS_DIR;
    process.env.AWSH_PACKS_DIR = dir;
    try {
      const found = findPack(join(tmpdir(), 'nope'), 'demopack');
      assert.ok(found, 'a pack in the explicit dir was not discovered');
      assert.ok(isUsable(found), 'a pack with a system_prompt must be launchable');
      assert.ok(discoverPacks(join(tmpdir(), 'nope')).some(p => p.name === 'demopack'));
    } finally {
      if (prev === undefined) delete process.env.AWSH_PACKS_DIR;
      else process.env.AWSH_PACKS_DIR = prev;
    }
  });
});
