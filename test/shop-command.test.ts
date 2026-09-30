/**
 * `aither shop` / `aither install <product>` / `aither license add`.
 *
 * What must hold and is not obvious from the source:
 *  - `aither install --profile …` (the sovereign install) is NOT captured by the
 *    product branch; only a known product id is.
 *  - every shape a buyer holds (base64 key, license.json, order JSON) parses to the
 *    same {payload, signature} envelope, and junk does not.
 *  - a license that fails awdk verification is never written, and one that would
 *    DROP a pack the current license grants is refused without --force.
 *  - a hosted product opens its page; an uninstalled one opens the shop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHOP_PRODUCTS, actionFor, findInstalled, findProduct, isProductInstall, parseLicenseText,
  runLicenseCommand, runProductInstall, runShopCommand, shopUrl, type ShopDeps,
} from '../src/shop-command.js';

const ENV = { payload: Buffer.from('{"tier":"pro","packs":["saga"]}').toString('base64'), signature: 'ab'.repeat(32) };
const KEY = Buffer.from(JSON.stringify(ENV)).toString('base64');

function deps(over: Partial<ShopDeps> & { verify?: (env: any) => any; packs?: Record<string, boolean> | null } = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'awsh-shop-'));
  const d: ShopDeps = {
    env: { AITHER_LICENSE_FILE: join(dir, 'license.json'), AITHER_APPS_DIR: join(dir, 'apps') },
    platform: 'linux',
    log: (l) => lines.push(l),
    which: () => null,
    openUrl: (u) => opened.push(u),
    python: (script, stdin) => {
      if (script.includes('is_pack_available')) {
        const packs = over.packs === undefined ? {} : over.packs;
        if (packs === null) return { status: 3, stdout: '' };
        return { status: 0, stdout: JSON.stringify(packs) };
      }
      const r = over.verify ? over.verify(JSON.parse(stdin)) : { ok: true, tier: 'pro', packs: ['saga'] };
      if (r === null) return { status: 3, stdout: '' };
      return { status: r.ok ? 0 : 1, stdout: JSON.stringify(r) };
    },
    ...over,
  };
  return { d, lines, opened, dir };
}

test('catalog: the four products, shop slugs under /shop/<id>', () => {
  assert.deepEqual(SHOP_PRODUCTS.map(p => p.id), ['deep-research', 'saga', 'agent-home', 'iris']);
  assert.equal(shopUrl(findProduct('saga')!), 'https://aitherium.com/shop/saga');
  assert.equal(findProduct('SAGA')?.pack, 'saga');
});

test('catalog: Aither Hearth keeps the agent-home id and never launches the help-only aither-hearth', () => {
  const hearth = findProduct('agent-home')!;
  assert.equal(hearth.name, 'Aither Hearth');
  assert.equal(hearth.pack, 'agent-home');
  // aither-hearth with no arguments prints help and exits: launching it did nothing.
  assert.deepEqual(hearth.executables, ['agent-home', 'aither-agent-home']);
  const onlyScript = (n: string) => (n === 'aither-hearth' ? '/usr/bin/aither-hearth' : null);
  assert.equal(findInstalled(hearth, deps({ which: onlyScript }).d), null);
  const oldOnly = (n: string) => (n === 'aither-agent-home' ? '/usr/bin/aither-agent-home' : null);
  assert.equal(findInstalled(hearth, deps({ which: oldOnly }).d), '/usr/bin/aither-agent-home');
});

test('isProductInstall: only a product id takes the product branch', () => {
  assert.equal(isProductInstall(['saga']), true);
  assert.equal(isProductInstall(['--profile', 'personal']), false);
  assert.equal(isProductInstall([]), false);
});

test('actionFor matches core/products.py', () => {
  const dr = findProduct('deep-research')!;
  assert.equal(actionFor(findProduct('iris')!, null, null), 'open');
  assert.equal(actionFor(dr, '/x/deep-research-agent', false), 'launch');
  assert.equal(actionFor(dr, null, true), 'install');
  assert.equal(actionFor(dr, null, false), 'shop');
  assert.equal(actionFor(dr, null, null), 'shop');
});

test('parseLicenseText: base64 key, license.json, order JSON; junk refused', () => {
  assert.deepEqual(parseLicenseText(KEY), ENV);
  assert.deepEqual(parseLicenseText(`  ${KEY}\n`), ENV);
  assert.deepEqual(parseLicenseText(JSON.stringify(ENV)), ENV);
  assert.deepEqual(parseLicenseText(JSON.stringify({ license: KEY, sku: 'saga_lifetime' })), ENV);
  assert.deepEqual(parseLicenseText(JSON.stringify({ license_key: KEY })), ENV);
  assert.equal(parseLicenseText('SAGA-not-a-key!'), null);
  assert.equal(parseLicenseText(Buffer.from('hello').toString('base64')), null);
  assert.equal(parseLicenseText(''), null);
});

test('license add: verified key is written as the decoded envelope', () => {
  const { d, lines } = deps();
  assert.equal(runLicenseCommand(['add', KEY], d), 0);
  const saved = JSON.parse(readFileSync(d.env!.AITHER_LICENSE_FILE!, 'utf-8'));
  assert.deepEqual(saved, ENV);
  assert.ok(lines.some(l => l.includes('packs: saga')));
});

test('license add: a key awdk rejects is NOT written', () => {
  const { d } = deps({ verify: () => ({ ok: false }) });
  assert.equal(runLicenseCommand(['add', KEY], d), 1);
  assert.equal(existsSync(d.env!.AITHER_LICENSE_FILE!), false);
});

test('license add: refuses to drop a pack the current license grants', () => {
  const { d, dir } = deps({
    verify: (env) => env.signature === 'old' ? { ok: true, tier: 'pro', packs: ['deep-research'] }
      : { ok: true, tier: 'pro', packs: ['saga'] },
  });
  const path = d.env!.AITHER_LICENSE_FILE!;
  writeFileSync(path, JSON.stringify({ payload: 'x', signature: 'old' }));
  assert.equal(runLicenseCommand(['add', KEY], d), 2);
  assert.equal(JSON.parse(readFileSync(path, 'utf-8')).signature, 'old');
  // --force replaces it and keeps a backup.
  assert.equal(runLicenseCommand(['add', KEY, '--force'], d), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ENV);
  assert.ok(readdirSync(dir).some(f => f.startsWith('license.json.bak-')));
});

test('license add: without awdk it will not overwrite an existing license', () => {
  const { d } = deps({ verify: () => null });
  const path = d.env!.AITHER_LICENSE_FILE!;
  writeFileSync(path, JSON.stringify({ payload: 'x', signature: 'old' }));
  assert.equal(runLicenseCommand(['add', KEY], d), 2);
  assert.equal(JSON.parse(readFileSync(path, 'utf-8')).signature, 'old');
});

test('license add: reads a file path', () => {
  const { d, dir } = deps();
  const f = join(dir, 'my.license');
  writeFileSync(f, KEY);
  assert.equal(runLicenseCommand(['add', f], d), 0);
  assert.deepEqual(JSON.parse(readFileSync(d.env!.AITHER_LICENSE_FILE!, 'utf-8')), ENV);
});

test('install: hosted opens its page, uninstalled opens the shop', async () => {
  const a = deps();
  assert.equal(await runProductInstall(['iris'], a.d), 0);
  assert.deepEqual(a.opened, ['https://aitherium.com/iris']);
  const b = deps({ packs: { saga: false } });
  assert.equal(await runProductInstall(['saga'], b.d), 0);
  assert.deepEqual(b.opened, ['https://aitherium.com/shop/saga']);
});

test('install: licensed-but-missing tells the buyer to use --from', async () => {
  const { d, lines } = deps({ packs: { saga: true } });
  await runProductInstall(['saga', '--no-open'], d);
  assert.ok(lines.some(l => l.includes('aither install saga --from')));
});

test('install --from: https download lands in apps/<id>/, http refused', async () => {
  const { d, dir } = deps({
    fetchImpl: (async () => new Response('BIN', {
      status: 200, headers: { 'content-disposition': 'attachment; filename="saga-linux"' },
    })) as any,
  });
  assert.equal(await runProductInstall(['saga', '--from', 'https://dl.example/t/abc'], d), 0);
  assert.equal(readFileSync(join(dir, 'apps', 'saga', 'saga-linux'), 'utf-8'), 'BIN');
  assert.equal(await runProductInstall(['saga', '--from', 'http://dl.example/x'], d), 1);
});

test('install: an exe in apps/<id>/ counts as installed', async () => {
  const { d, lines } = deps({ fileExists: (p: string) => p.endsWith(join('apps', 'saga', 'saga')) || existsSync(p) });
  assert.equal(await runProductInstall(['saga'], d), 0);
  assert.ok(lines.some(l => l.includes('already installed')));
});

test('shop: lists every product, and unknown awdk reads as unknown', () => {
  const { d, lines } = deps({ packs: null });
  assert.equal(runShopCommand([], d), 0);
  for (const p of SHOP_PRODUCTS) assert.ok(lines.some(l => l.includes(p.name)), p.name);
  assert.ok(lines.some(l => l.includes('license unknown')));
  const e = deps();
  assert.equal(runShopCommand(['nope'], e.d), 1);
});
