/**
 * `aither shop`, `aither install <product>`, `aither license add <file|text>`.
 *
 * The desktop products (Deep Research Studio, Saga, Agent Home) and the hosted one
 * (Iris), from the terminal:
 *
 *   aither shop                    list them: installed? licensed? what to do next
 *   aither shop <product>          open its shop page
 *   aither install <product>       launch-ready check; opens the shop / download page
 *   aither launch <product>        run an installed app (a CLI product such as Aither
 *                                  Hearth runs right here, in this terminal)
 *   aither install <product> --from <url|file>
 *                                  put the download from your purchase email into
 *                                  ~/.aither/apps/<product>/ (https only)
 *   aither license add <file|text|->
 *                                  save a purchased license to ~/.aither/license.json,
 *                                  where awdk's LicenseManager reads it
 *
 * Licensing is awdk's, not a second implementation: status and verification shell
 * out to `python -c` against `adk.licensing` (the same `is_pack_available` the apps
 * gate on). Without awdk the answer is "unknown" and a license is saved only after a
 * structural check, with the previous file kept as a backup -- never silently
 * replaced by something that does not verify.
 *
 * A product that ships as a CLI (Aither Hearth: awdk's `aither-hearth` console
 * script) names the arguments a launch passes (`launchArgs`: `serve --pair`). An
 * executable that only MAY carry the product (`adk`, which has `adk home` only in
 * recent awdk releases) counts as installed only when its `probeArgs` exit 0.
 *
 * The catalog mirrors AitherDesktop's core/products.py (the parity test there reads
 * this file).
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pythonExecutable } from './claude-command.js';

export const SHOP_BASE = (process.env.AITHER_SHOP_URL || 'https://aitherium.com/shop').replace(/\/+$/, '');

export interface ShopProduct {
  id: string;
  name: string;
  kind: 'local' | 'hosted';
  pack: string | null;
  executables: string[];
  /** executable -> the arguments a launch passes it (absent: none). */
  launchArgs?: Record<string, string[]>;
  /** executable -> arguments that must exit 0 before it counts as this product. */
  probeArgs?: Record<string, string[]>;
  /** Its output must be read (Hearth prints a pairing code): run it in a terminal. */
  console?: boolean;
  webUrl?: string;
  blurb: string;
}

export const SHOP_PRODUCTS: readonly ShopProduct[] = Object.freeze([
  { id: 'deep-research', name: 'Deep Research Studio', kind: 'local', pack: 'deep-research',
    executables: ['deep-research-agent', 'deep-research-studio'],
    blurb: 'Multi-source, fact-checked research reports on your own machine.' },
  { id: 'saga', name: 'Saga', kind: 'local', pack: 'saga', executables: ['saga'],
    blurb: 'An AI game master for solo tabletop RPGs, running on your PC.' },
  { id: 'agent-home', name: 'Aither Hearth', kind: 'local', pack: 'agent-home',
    // awdk ships `aither-hearth`; bare it prints help and exits, so a launch runs
    // `serve --pair` (the agent answers and prints the phone pairing code).
    // agent-home / aither-agent-home are the pre-rename names, kept as fallbacks;
    // `adk home serve --pair` covers an awdk older than the console script.
    executables: ['aither-hearth', 'agent-home', 'aither-agent-home', 'adk'],
    launchArgs: { 'aither-hearth': ['serve', '--pair'], adk: ['home', 'serve', '--pair'] },
    probeArgs: { adk: ['home', '--help'] },
    console: true,
    blurb: 'Your own agent on your own machine; reach it from your phone.' },
  { id: 'iris', name: 'Iris', kind: 'hosted', pack: null, executables: [],
    webUrl: 'https://aitherium.com/iris',
    blurb: 'Hosted image and scene art studio (credits or Iris Pro).' },
]);

export function findProduct(id: string | undefined): ShopProduct | undefined {
  const key = String(id || '').trim().toLowerCase();
  return SHOP_PRODUCTS.find(p => p.id === key);
}

export function shopUrl(p: ShopProduct): string {
  return `${SHOP_BASE}/${p.id}`;
}

export function appsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AITHER_APPS_DIR || join(homedir(), '.aither', 'apps');
}

export function licensePath(env: NodeJS.ProcessEnv = process.env): string {
  // adk.licensing reads AITHER_LICENSE_FILE first; writing anywhere else would be
  // a license nobody reads.
  return env.AITHER_LICENSE_FILE || join(homedir(), '.aither', 'license.json');
}

// ── deps (injectable for tests) ─────────────────────────────────────────────

export interface ShopDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  log?: (line: string) => void;
  /** Resolve an executable on PATH; null when absent. */
  which?: (name: string) => string | null;
  fileExists?: (path: string) => boolean;
  /** Run python with a script + stdin; returns {status, stdout}. */
  python?: (script: string, stdin: string) => { status: number | null; stdout: string };
  openUrl?: (url: string) => void;
  fetchImpl?: typeof fetch;
  /** True when `file args...` exits 0 (the probe for an executable that MAY be the product). */
  probe?: (file: string, args: string[]) => boolean;
  /** Run an installed product in THIS terminal; returns its exit status. */
  run?: (file: string, args: string[]) => number | null;
}

function defaultWhich(platform: string) {
  return (name: string): string | null => {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf-8' });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.split(/\r?\n/)[0].trim() || null;
  };
}

function defaultPython(env: NodeJS.ProcessEnv) {
  return (script: string, stdin: string) => {
    const r = spawnSync(pythonExecutable(env), ['-c', script], {
      input: stdin, encoding: 'utf-8', timeout: 30_000,
    });
    return { status: r.error ? null : r.status, stdout: r.stdout || '' };
  };
}

function defaultOpenUrl(platform: string) {
  return (url: string) => {
    if (!/^https:\/\//i.test(url)) return;
    if (platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else spawnSync(platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  };
}

const probeCache = new Map<string, boolean>();

function defaultProbe(file: string, args: string[]): boolean {
  const key = JSON.stringify([file, ...args]);
  if (!probeCache.has(key)) {
    const r = spawnSync(file, args, { stdio: 'ignore', timeout: 30_000, windowsHide: true });
    probeCache.set(key, !r.error && r.status === 0);
  }
  return probeCache.get(key)!;
}

function defaultRun(file: string, args: string[]): number | null {
  const r = spawnSync(file, args, { stdio: 'inherit' });
  return r.error ? null : r.status;
}

function resolved(deps: ShopDeps) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  return {
    env, platform,
    log: deps.log || ((line: string) => console.log(line)),
    which: deps.which || defaultWhich(platform),
    fileExists: deps.fileExists || existsSync,
    python: deps.python || defaultPython(env),
    openUrl: deps.openUrl || defaultOpenUrl(platform),
    fetchImpl: deps.fetchImpl || fetch,
    probe: deps.probe || defaultProbe,
    run: deps.run || defaultRun,
  };
}

// ── status ──────────────────────────────────────────────────────────────────

export interface LaunchTarget { path: string; args: string[] }

/** The executable and arguments a launch runs, or null. Hosted products are never installed. */
export function findLaunch(p: ShopProduct, deps: ShopDeps = {}): LaunchTarget | null {
  if (p.kind !== 'local') return null;
  const d = resolved(deps);
  const argsFor = (exe: string) => [...(p.launchArgs?.[exe] || [])];
  const admitted = (exe: string, file: string) => {
    const needs = p.probeArgs?.[exe];
    return !needs || d.probe(file, [...needs]);
  };
  const dir = join(appsDir(d.env), p.id);
  for (const exe of p.executables) {
    for (const name of d.platform === 'win32' ? [`${exe}.exe`, exe] : [exe]) {
      const candidate = join(dir, name);
      if (d.fileExists(candidate) && admitted(exe, candidate)) return { path: candidate, args: argsFor(exe) };
    }
  }
  for (const exe of p.executables) {
    const hit = d.which(exe);
    if (hit && admitted(exe, hit)) return { path: hit, args: argsFor(exe) };
  }
  return null;
}

export function findInstalled(p: ShopProduct, deps: ShopDeps = {}): string | null {
  const hit = findLaunch(p, deps);
  return hit ? hit.path : null;
}

function commandLine(t: LaunchTarget): string {
  return [t.path, ...t.args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

const PACK_STATUS_PY = [
  'import json, sys',
  'try:',
  '    from adk.licensing import get_license_manager',
  'except Exception:',
  '    sys.exit(3)',
  'm = get_license_manager()',
  'print(json.dumps({p: bool(m.is_pack_available(p)) for p in json.loads(sys.stdin.read())}))',
].join('\n');

/** pack -> licensed, or null when awdk cannot answer (not installed / crashed). */
export function packStatus(packs: string[], deps: ShopDeps = {}): Record<string, boolean> | null {
  const d = resolved(deps);
  const r = d.python(PACK_STATUS_PY, JSON.stringify(packs));
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { return null; }
}

export type ProductAction = 'open' | 'launch' | 'install' | 'shop';

export interface ProductRow {
  product: ShopProduct;
  installedPath: string | null;
  licensed: boolean | null;
  action: ProductAction;
}

/** Same rule as AitherDesktop core/products.py product_status(). */
export function actionFor(p: ShopProduct, installedPath: string | null, licensed: boolean | null): ProductAction {
  if (p.kind === 'hosted') return 'open';
  if (installedPath) return 'launch';
  if (licensed) return 'install';
  return 'shop';
}

export function productRows(deps: ShopDeps = {}): ProductRow[] {
  const packs = SHOP_PRODUCTS.map(p => p.pack).filter((x): x is string => !!x);
  const status = packStatus(packs, deps);
  return SHOP_PRODUCTS.map(p => {
    const installedPath = findInstalled(p, deps);
    const licensed = p.pack && status ? !!status[p.pack] : null;
    return { product: p, installedPath, licensed, action: actionFor(p, installedPath, licensed) };
  });
}

// ── aither shop ─────────────────────────────────────────────────────────────

export function runShopCommand(args: string[], deps: ShopDeps = {}): number {
  const d = resolved(deps);
  const target = args.find(a => !a.startsWith('-'));
  if (target) {
    const p = findProduct(target);
    if (!p) {
      d.log(`  Unknown product "${target}". Try: ${SHOP_PRODUCTS.map(x => x.id).join(', ')}`);
      return 1;
    }
    const url = shopUrl(p);
    d.log(`  ${p.name}: ${url}`);
    if (!args.includes('--no-open')) d.openUrl(url);
    return 0;
  }
  const rows = productRows(deps);
  d.log('');
  d.log('  Aitherium apps');
  d.log('');
  for (const r of rows) {
    const state = r.product.kind === 'hosted' ? 'hosted'
      : r.installedPath ? 'installed' : 'not installed';
    const lic = r.product.pack == null ? '' : r.licensed === null ? ' · license unknown (awdk not found)'
      : r.licensed ? ' · licensed' : ' · not licensed';
    d.log(`  ${r.product.id.padEnd(14)} ${r.product.name.padEnd(22)} ${state}${lic}`);
    d.log(`  ${''.padEnd(14)} ${r.product.blurb}`);
  }
  d.log('');
  d.log(`  Buy:      aither shop <product>        (${SHOP_BASE})`);
  d.log('  Install:  aither install <product> [--from <download link>]');
  d.log('  Launch:   aither launch <product>');
  d.log('  License:  aither license add <file|text>');
  return 0;
}

// ── aither install <product> ────────────────────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** True when `aither install <x>` names a product (else the sovereign install runs). */
export function isProductInstall(args: string[]): boolean {
  return !!findProduct(args[0]);
}

export async function runProductInstall(args: string[], deps: ShopDeps = {}): Promise<number> {
  const d = resolved(deps);
  const p = findProduct(args[0]);
  if (!p) { d.log(`  Unknown product "${args[0]}".`); return 1; }

  if (p.kind === 'hosted') {
    d.log(`  ${p.name} is hosted -- nothing to install. Opening ${p.webUrl}`);
    d.openUrl(p.webUrl!);
    return 0;
  }

  const from = flagValue(args, '--from');
  if (from) return installFrom(p, from, d);

  const existing = findLaunch(p, deps);
  if (existing) {
    d.log(`  ${p.name} is already installed: ${existing.path}`);
    d.log(`  Start it:  aither launch ${p.id}   (runs ${commandLine(existing)})`);
    return 0;
  }
  const status = p.pack ? packStatus([p.pack], deps) : null;
  const url = shopUrl(p);
  if (status && p.pack && status[p.pack]) {
    d.log(`  ${p.name} is licensed on this machine but not installed.`);
    d.log('  Use the download link from your purchase email:');
    d.log(`    aither install ${p.id} --from <download link>`);
    d.log(`  Lost it?  ${url}  (or: resend from the shop page)`);
  } else {
    d.log(`  ${p.name} is not installed${status ? ' and not licensed' : ''}. Opening ${url}`);
    d.log(`  After purchase:  aither license add <license>  then  aither install ${p.id} --from <download link>`);
  }
  if (!args.includes('--no-open')) d.openUrl(url);
  return 0;
}

// ── aither launch <product> ─────────────────────────────────────────────────

/** True when `aither launch <x>` names a product. */
export function isProductLaunch(args: string[]): boolean {
  return !!findProduct(args[0]);
}

/**
 * Run an installed product. This command already has a terminal, so a CLI product
 * (Hearth: `aither-hearth serve --pair`) runs right here and prints its pairing
 * code; Ctrl+C stops it. Hosted opens its page; not installed goes where
 * `aither install` goes (the download or the shop).
 */
export async function runProductLaunch(args: string[], deps: ShopDeps = {}): Promise<number> {
  const d = resolved(deps);
  const p = findProduct(args[0]);
  if (!p) { d.log(`  Unknown product "${args[0]}".`); return 1; }
  if (p.kind === 'hosted') {
    d.log(`  ${p.name} is hosted. Opening ${p.webUrl}`);
    d.openUrl(p.webUrl!);
    return 0;
  }
  const target = findLaunch(p, deps);
  if (!target) return runProductInstall([p.id, ...args.slice(1)], deps);
  d.log(`  Starting ${p.name}: ${commandLine(target)}`);
  if (p.console) d.log('  It runs in this terminal -- Ctrl+C stops it.');
  const status = d.run(target.path, target.args);
  if (status === null) {
    d.log(`  Could not start ${p.name}. Run it yourself: ${commandLine(target)}`);
    return 1;
  }
  return status;
}

async function installFrom(p: ShopProduct, from: string, d: ReturnType<typeof resolved>): Promise<number> {
  const dir = join(appsDir(d.env), p.id);
  let bytes: Buffer;
  let name: string;
  if (/^https:\/\//i.test(from)) {
    let resp: Response;
    try {
      resp = await d.fetchImpl(from, { redirect: 'follow' });
    } catch (e: any) {
      d.log(`  Download failed: ${e?.message || e}`);
      return 1;
    }
    if (!resp.ok) { d.log(`  Download failed: HTTP ${resp.status}`); return 1; }
    bytes = Buffer.from(await resp.arrayBuffer());
    const cd = resp.headers.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    name = basename(decodeURIComponent(m ? m[1] : new URL(from).pathname.split('/').pop() || ''));
  } else if (/^[a-z]+:\/\//i.test(from)) {
    d.log('  Refused: only https:// download links (or a local file) are accepted.');
    return 1;
  } else {
    if (!d.fileExists(from)) { d.log(`  No such file: ${from}`); return 1; }
    bytes = readFileSync(from);
    name = basename(from);
  }
  if (!name || name === '.' || name === '..') name = d.platform === 'win32' ? `${p.executables[0]}.exe` : p.executables[0];
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  writeFileSync(dest, bytes);
  if (d.platform !== 'win32' && !/\.(zip|tar|gz|tgz|whl)$/i.test(name)) {
    try { chmodSync(dest, 0o755); } catch { /* best effort */ }
  }
  d.log(`  Saved ${p.name} -> ${dest} (${bytes.length} bytes)`);
  if (/\.(zip|tar|gz|tgz)$/i.test(name)) d.log(`  It is an archive: extract it into ${dir} to launch it from the desktop tiles.`);
  else if (/\.whl$/i.test(name)) d.log(`  It is a Python wheel: pip install "${dest}"`);
  return 0;
}

// ── aither license add ──────────────────────────────────────────────────────

export interface Envelope { payload: string; signature: string }

/**
 * Accept every shape a buyer can hold: the base64 key from the email, the
 * {payload, signature} JSON (license.json itself), or an order/login JSON that
 * carries it under `license_key` / `license`.
 */
export function parseLicenseText(text: string): Envelope | null {
  const t = String(text || '').trim();
  if (!t) return null;
  const asEnvelope = (v: any): Envelope | null => {
    if (v && typeof v === 'object') {
      if (typeof v.payload === 'string' && typeof v.signature === 'string') {
        return { payload: v.payload, signature: v.signature };
      }
      for (const k of ['license_key', 'license']) {
        if (typeof v[k] === 'string') return parseLicenseText(v[k]);
        if (v[k] && typeof v[k] === 'object') return asEnvelope(v[k]);
      }
    }
    return null;
  };
  if (t.startsWith('{')) {
    try { return asEnvelope(JSON.parse(t)); } catch { return null; }
  }
  if (!/^[A-Za-z0-9+/=_\-\s]+$/.test(t)) return null;
  try {
    const decoded = Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf-8');
    return decoded.trim().startsWith('{') ? asEnvelope(JSON.parse(decoded)) : null;
  } catch {
    return null;
  }
}

const VERIFY_PY = [
  'import json, sys',
  'try:',
  '    from adk import licensing as L',
  'except Exception:',
  '    sys.exit(3)',
  'lic = L._license_from_envelope(json.loads(sys.stdin.read()), source="awsh")',
  'if lic is None:',
  '    print(json.dumps({"ok": False})); sys.exit(1)',
  'print(json.dumps({"ok": True, "tier": lic.tier.value, "packs": list(lic.packs or [])}))',
].join('\n');

export interface VerifyResult { verified: boolean | null; tier?: string; packs?: string[] }

export function verifyEnvelope(env: Envelope, deps: ShopDeps = {}): VerifyResult {
  const d = resolved(deps);
  const r = d.python(VERIFY_PY, JSON.stringify(env));
  if (r.status === 3 || r.status === null) return { verified: null };
  try {
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || '{}');
    if (r.status === 0 && out.ok) return { verified: true, tier: out.tier, packs: out.packs };
  } catch { /* fall through */ }
  return { verified: false };
}

export function runLicenseCommand(args: string[], deps: ShopDeps = {}, readStdin: () => string = () => readFileSync(0, 'utf-8')): number {
  const d = resolved(deps);
  const [sub, ...rest] = args;
  const path = licensePath(d.env);
  if (sub === 'status' || !sub) {
    const rows = productRows(deps).filter(r => r.product.pack);
    d.log(`  License file: ${path}${d.fileExists(path) ? '' : ' (none)'}`);
    for (const r of rows) {
      d.log(`  ${r.product.pack!.padEnd(14)} ${r.licensed === null ? 'unknown (awdk not found)' : r.licensed ? 'licensed' : 'not licensed'}`);
    }
    return 0;
  }
  if (sub !== 'add') {
    d.log('  Usage: aither license add <file|text|->   |   aither license status');
    return 1;
  }
  const force = rest.includes('--force');
  const arg = rest.filter(a => a !== '--force').join(' ').trim();
  if (!arg) { d.log('  Usage: aither license add <file|text|->   (- reads stdin)'); return 1; }
  let text = arg;
  if (arg === '-') text = readStdin();
  else if (d.fileExists(arg)) text = readFileSync(arg, 'utf-8');

  const env = parseLicenseText(text);
  if (!env) {
    d.log('  Refused: that is not a license (expected the key from your purchase email or a license .json).');
    return 1;
  }
  const v = verifyEnvelope(env, deps);
  if (v.verified === false) {
    d.log('  Refused: the license signature did not verify (or it expired). Nothing was written.');
    return 1;
  }
  if (v.verified === null && d.fileExists(path) && !force) {
    d.log('  awdk is not installed, so this license cannot be verified, and a license already exists.');
    d.log('  Install awdk (pip install awdk) and retry, or pass --force to replace it (the old one is backed up).');
    return 2;
  }
  // ONE license file: replacing it with a license that lacks a pack the current
  // one grants would silently lock an app the buyer already paid for.
  if (v.verified && d.fileExists(path) && !force) {
    let old: VerifyResult = { verified: null };
    try {
      const prev = parseLicenseText(readFileSync(path, 'utf-8'));
      if (prev) old = verifyEnvelope(prev, deps);
    } catch { /* unreadable old file: nothing to lose */ }
    const lost = (old.verified && old.packs ? old.packs : []).filter(p => !(v.packs || []).includes(p));
    if (lost.length) {
      d.log(`  Refused: your current license grants ${lost.join(', ')}, which this one does not.`);
      d.log('  Use the most recent license from the shop (it covers everything you bought),');
      d.log('  or pass --force to replace it anyway (the old one is backed up).');
      return 2;
    }
  }
  mkdirSync(join(path, '..'), { recursive: true });
  if (d.fileExists(path)) {
    const backup = `${path}.bak-${Date.now()}`;
    try { copyFileSync(path, backup); d.log(`  Previous license kept at ${backup}`); } catch { /* best effort */ }
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(env), 'utf-8');
  renameSync(tmp, path);
  if (v.verified) {
    d.log(`  License saved -> ${path} (tier ${v.tier}${v.packs && v.packs.length ? `, packs: ${v.packs.join(', ')}` : ''})`);
  } else {
    d.log(`  License saved -> ${path} (not verified: awdk not installed; apps verify it on start)`);
  }
  if (d.env.AITHER_LICENSE_KEY) d.log('  Warning: AITHER_LICENSE_KEY is set and takes precedence over this file.');
  return 0;
}
