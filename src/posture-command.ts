/**
 * `/posture` (alias `/house`) and the status-bar `● Dark` segment -- the house posture and
 * the on-demand wake groups, from the terminal.
 *
 *   /posture                          posture + the three must-answer surfaces + every group
 *   /posture shop|after|game|dark|auto [--until 23:30|2h]   flip the house posture
 *   /posture wake <group>             bring a group (darkmatter, dgg, shop, vibe, ...) up
 *   /posture sleep <group>            park it now
 *   ... --json                        the raw tool answers
 *
 * Source of truth: the platform gateway's owner-only MCP tools `fleet_posture_status`,
 * `fleet_posture_set`, `fleet_group_status`, `fleet_group_wake`, `fleet_group_park`, asked on
 * the LOCAL gateway with the session bearer -- the same door and bearer as `/spend`
 * (spend-command.ts). The rules (owner only, closed word set, signed flip) live in the
 * gateway; this file only names the tools and prints their answers in Veil's words
 * (AitherVeil/src/lib/posture-client.ts). Not `/fleet`: `/fleet sleep` turns the VM off.
 *
 * The status bar never waits on the network: it reads ~/.aither/posture-cache.json and, when
 * that is older than a minute, refreshes it in the background for the next paint.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpHttpClient } from './mcp-client.js';
import { readBearer, SPEND_MCP_URL, toolPayload } from './spend-command.js';

export type PostureWord = 'shop' | 'after' | 'game' | 'dark' | 'auto';

/** Mirrors mcp_fleet_posture.WORDS / posture-client.ts POSTURE_WORDS, in card order. */
export const POSTURE_WORDS: readonly PostureWord[] = ['shop', 'after', 'game', 'dark', 'auto'];

/** Exactly Veil's labels (posture-client.ts POSTURE_LABELS). */
export const POSTURE_LABELS: Readonly<Record<PostureWord, string>> = Object.freeze({
  shop: 'Shop open',
  after: 'After hours',
  game: 'Game on',
  dark: 'Dark',
  auto: 'On schedule',
});

export const SURFACE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // Tenant surfaces are labelled from the key the gateway sends; no customer name
  // ships in this package (check_adk_publishable AWS003).
  app: 'App', hearth: 'Hearth',
});

/** Mirrors mcp_fleet_posture.UNTIL_RE. */
export const UNTIL_RE =
  /^(?:\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,4}[mh])$/;

const AITHER_HOME = process.env.AITHER_HOME || join(homedir(), '.aither');
export const POSTURE_CACHE_PATH = join(AITHER_HOME, 'posture-cache.json');
export const REFRESH_EVERY_S = 60;
const HIDE_AFTER_S = 3600;
export const SLEEP_UNAVAILABLE = 'sleep not available yet on this gateway';

/** Call one gateway tool, resolve its JSON payload (or `{error}`). */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export interface HouseGroup {
  name: string;
  /** awake | waking | parked | failed | down | unknown */
  state: string;
  summary: string;
  idleS: number | null;
  etaS: number | null;
  idleParkMin: number | null;
  problem: string;
}

export interface HouseView {
  /** "Shop open" ... or "unknown" when the house did not answer. */
  label: string;
  surfaces: { name: string; label: string; up: boolean }[];
  gpu: string;
  next: string;
  problem: string;
  groups: HouseGroup[];
  groupsProblem: string;
}

/** A label the tools gave, only when it is one of Veil's words; else "unknown". */
export function postureLabel(v: unknown): string {
  const known = Object.values(POSTURE_LABELS);
  if (isRec(v) && typeof v.label === 'string' && known.includes(v.label)) return v.label;
  return 'unknown';
}

function gpuWords(gpu: unknown): string {
  if (typeof gpu === 'string') return gpu;
  if (isRec(gpu) && typeof gpu.parked === 'boolean') return gpu.parked ? 'parked' : 'serving';
  return '';
}

function nextWords(next: unknown): string {
  if (typeof next === 'string') return next;
  if (isRec(next)) {
    const w = typeof next.word === 'string' && next.word in POSTURE_LABELS
      ? POSTURE_LABELS[next.word as PostureWord] : '';
    const at = typeof next.at === 'string' ? next.at : '';
    return [w, at].filter(Boolean).join(' at ');
  }
  return '';
}

/** Pure: a `fleet_posture_status` payload -> label, surfaces, gpu, next, problem. */
export function postureView(v: unknown): Omit<HouseView, 'groups' | 'groupsProblem'> {
  if (!isRec(v)) {
    return { label: 'unknown', surfaces: [], gpu: '', next: '', problem: 'The house did not answer.' };
  }
  const surfaces = isRec(v.surfaces)
    ? Object.entries(v.surfaces).map(([name, s]) => ({
      name, label: SURFACE_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1), up: isRec(s) && s.up === true,
    }))
    : [];
  const down = surfaces.filter(s => !s.up).map(s => s.label);
  let problem = typeof v.error === 'string' ? v.error : '';
  if (!problem && down.length) problem = `${down.join(', ')} not answering.`;
  return { label: postureLabel(v), surfaces, gpu: gpuWords(v.gpu), next: nextWords(v.next), problem };
}

/** Pure: one `fleet_group_status {name}` payload -> a row. */
export function groupRow(name: string, v: unknown, summary = ''): HouseGroup {
  if (!isRec(v)) {
    return { name, state: 'unknown', summary, idleS: null, etaS: null, idleParkMin: null,
      problem: 'no answer' };
  }
  let state = typeof v.state === 'string' && v.state ? v.state : '';
  if (v.up === true) state = 'awake';
  else if (!state) state = v.up === false ? 'down' : 'unknown';
  return {
    name,
    state,
    summary: typeof v.summary === 'string' && v.summary ? v.summary : summary,
    idleS: num(v.idle_s),
    etaS: num(v.eta_s),
    idleParkMin: num(v.idle_park_min),
    problem: typeof v.error === 'string' ? v.error : '',
  };
}

const span = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m`
  : `${Math.round(s / 3600)}h`);

/** The `/posture` readout, plain lines. */
export function formatHouse(view: HouseView): string[] {
  const out: string[] = [];
  const extra = [view.gpu ? `GPU ${view.gpu}` : '', view.next ? `next: ${view.next}` : '']
    .filter(Boolean).join(' · ');
  out.push(`House  ● ${view.label}${extra ? `   (${extra})` : ''}`);
  if (view.surfaces.length) {
    out.push('  ' + view.surfaces.map(s => `${s.label} ${s.up ? 'up' : 'DOWN'}`).join(' · '));
  }
  if (view.problem) out.push(`  ! ${view.problem}`);
  out.push('');
  out.push('Groups');
  if (view.groupsProblem) out.push(`  ! ${view.groupsProblem}`);
  if (!view.groups.length && !view.groupsProblem) out.push('  (none reported)');
  for (const g of view.groups) {
    const bits: string[] = [];
    if (g.state === 'awake' && g.idleS !== null) bits.push(`idle ${span(g.idleS)}`);
    if (g.state === 'awake' && g.idleParkMin !== null) bits.push(`sleeps after ${g.idleParkMin}m idle`);
    if (g.state === 'waking' && g.etaS !== null) bits.push(`~${Math.round(g.etaS)} s`);
    if (g.problem) bits.push(g.problem);
    const verb = g.state === 'awake' || g.state === 'waking' ? 'sleep' : 'wake';
    out.push(`  ${g.name.padEnd(11)} ${g.state.padEnd(8)} ${bits.join(' · ')}`.trimEnd()
      + `   /posture ${verb} ${g.name}`);
  }
  out.push('');
  out.push(`Set: /posture ${POSTURE_WORDS.join('|')} [--until 23:30|2h]`);
  return out;
}

// ── the gateway ───────────────────────────────────────────────────────────────

/** True when the gateway says it has no such tool (fleet_group_park before it lands). */
export function isUnknownTool(v: unknown): boolean {
  const text = isRec(v) && typeof v.error === 'string' ? v.error : typeof v === 'string' ? v : '';
  return /unknown tool|tool not found|no such tool|not found: fleet_|method not found/i.test(text);
}

export const callGatewayTool: ToolCaller = async (name, args) => {
  const bearer = readBearer();
  if (!bearer) {
    throw new Error('no gateway bearer (~/.aither/session-bearer); re-mint with mint_session_bearer.py');
  }
  const client = new McpHttpClient(SPEND_MCP_URL, bearer);
  return toolPayload(await client.callTool(name, args));
};

/** A call that never throws: a transport failure becomes `{error}`. */
async function safeCall(call: ToolCaller, name: string, args: Rec): Promise<unknown> {
  try {
    return await call(name, args);
  } catch (e: unknown) {
    return { ok: false, error: errText(e) };
  }
}

/** Posture + every group's status. Never throws. */
export async function gatherHouse(call: ToolCaller = callGatewayTool): Promise<{
  view: HouseView; raw: { posture: unknown; groups: unknown; each: Rec };
}> {
  // One at a time: the gateway session serialises calls anyway.
  const posture = await safeCall(call, 'fleet_posture_status', {});
  const list = await safeCall(call, 'fleet_group_status', {});
  const view: HouseView = { ...postureView(posture), groups: [], groupsProblem: '' };
  const each: Rec = {};
  if (isRec(list) && isRec(list.groups)) {
    for (const [name, g] of Object.entries(list.groups)) {
      const summary = isRec(g) && typeof g.summary === 'string' ? g.summary : '';
      const st = await safeCall(call, 'fleet_group_status', { name });
      each[name] = st;
      view.groups.push(groupRow(name, st, summary));
    }
  } else {
    view.groupsProblem = isRec(list) && typeof list.error === 'string'
      ? list.error : 'the gateway gave no group list';
  }
  return { view, raw: { posture, groups: list, each } };
}

// ── cache (status bar) ────────────────────────────────────────────────────────

export interface PostureCache {
  label: string | null;
  surfacesDown: string[];
  fetched_at: number | null;   // epoch SECONDS of the last good answer
  attempted_at: number | null;
  error: string | null;
}

export function readPostureCache(path = POSTURE_CACHE_PATH): PostureCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isRec(parsed) ? parsed as unknown as PostureCache : null;
  } catch {
    return null;
  }
}

export function writePostureCache(cache: PostureCache, path = POSTURE_CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
  renameSync(tmp, path);
}

/** Status-bar text: '' (hide) unless a measured Veil label is cached and under an hour old. */
export function segmentFromCache(cache: PostureCache | null, nowS = Date.now() / 1000):
  { text: string; word: PostureWord | null; alert: boolean } {
  const fetched = num(cache?.fetched_at);
  const label = cache?.label || '';
  const entry = Object.entries(POSTURE_LABELS).find(([, l]) => l === label);
  if (!entry || fetched === null || nowS - fetched > HIDE_AFTER_S) {
    return { text: '', word: null, alert: false };
  }
  const down = Array.isArray(cache?.surfacesDown) ? cache!.surfacesDown : [];
  return { text: label + (down.length ? ` · ${down.join(',')} down` : ''),
    word: entry[0] as PostureWord, alert: down.length > 0 };
}

export function cacheNeedsRefresh(cache: PostureCache | null, nowS = Date.now() / 1000): boolean {
  if (!cache) return true;
  const last = num(cache.attempted_at) ?? num(cache.fetched_at) ?? 0;
  return nowS - last >= REFRESH_EVERY_S;
}

/** Record a posture answer (good or bad) in the cache; a failure keeps the last good label. */
export function recordPosture(payload: unknown, path = POSTURE_CACHE_PATH,
  nowS = Date.now() / 1000): PostureCache {
  const prior = readPostureCache(path);
  const view = postureView(payload);
  const cache: PostureCache = {
    label: prior?.label ?? null, surfacesDown: prior?.surfacesDown ?? [],
    fetched_at: prior?.fetched_at ?? null, attempted_at: nowS, error: null,
  };
  if (view.label !== 'unknown') {
    cache.label = view.label;
    cache.surfacesDown = view.surfaces.filter(s => !s.up).map(s => s.label);
    cache.fetched_at = nowS;
  } else {
    cache.error = view.problem || 'unknown posture';
  }
  try { writePostureCache(cache, path); } catch { /* the next paint fetches again */ }
  return cache;
}

export async function refreshPostureCache(call: ToolCaller = callGatewayTool,
  path = POSTURE_CACHE_PATH): Promise<PostureCache> {
  return recordPosture(await safeCall(call, 'fleet_posture_status', {}), path);
}

let refreshing: Promise<PostureCache> | null = null;

/** Status-bar segment: reads the cache NOW, kicks a background refresh when stale. */
export function postureBarSegment(call: ToolCaller = callGatewayTool, path = POSTURE_CACHE_PATH):
  { text: string; word: PostureWord | null; alert: boolean } {
  const cache = readPostureCache(path);
  if (cacheNeedsRefresh(cache) && !refreshing) {
    refreshing = refreshPostureCache(call, path).finally(() => { refreshing = null; });
    refreshing.catch(() => { /* recorded in the cache */ });
  }
  return segmentFromCache(cache);
}

// ── the command ───────────────────────────────────────────────────────────────

export interface PostureDeps {
  call?: ToolCaller;
  print?: (line: string) => void;
  cachePath?: string | null;  // null = do not write the status-bar cache
}

export const POSTURE_USAGE =
  'usage: /posture [shop|after|game|dark|auto [--until 23:30|2h]] | wake <group> | sleep <group> [--json]';

function problemOf(v: unknown, fallback: string): string {
  if (isRec(v) && typeof v.error === 'string' && v.error) return v.error;
  return fallback;
}

export async function runPostureCommand(args: string[], deps: PostureDeps = {}): Promise<number> {
  const print = deps.print || ((l: string) => console.log(l));
  const call = deps.call || callGatewayTool;
  const cachePath = deps.cachePath === undefined ? POSTURE_CACHE_PATH : deps.cachePath;
  const json = args.includes('--json');
  let until = '';
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') continue;
    if (a === '--until') { until = args[++i] || ''; continue; }
    if (a.startsWith('--until=')) { until = a.slice(8); continue; }
    if (a.startsWith('--')) { print(POSTURE_USAGE); return 2; }
    pos.push(a);
  }
  const verb = (pos[0] || 'status').toLowerCase();

  if (verb === 'status' || verb === 'show' || verb === 'groups') {
    if (pos.length > 1 || until) { print(POSTURE_USAGE); return 2; }
    const { view, raw } = await gatherHouse(call);
    if (cachePath) recordPosture(raw.posture, cachePath);
    if (json) { print(JSON.stringify(raw, null, 2)); return view.label === 'unknown' ? 2 : 0; }
    print('');
    for (const line of formatHouse(view)) print('  ' + line);
    print('');
    return view.label === 'unknown' ? 2 : 0;
  }

  if (verb === 'wake' || verb === 'sleep' || verb === 'park') {
    const name = (pos[1] || '').trim().toLowerCase();
    if (!name || pos.length > 2 || until) { print(POSTURE_USAGE); return 2; }
    const tool = verb === 'wake' ? 'fleet_group_wake' : 'fleet_group_park';
    const res = await safeCall(call, tool, { name });
    if (json) { print(JSON.stringify(res, null, 2)); return isRec(res) && res.ok === true ? 0 : 1; }
    if (verb !== 'wake' && isUnknownTool(res)) { print(`  ${SLEEP_UNAVAILABLE}`); return 2; }
    if (!isRec(res) || res.ok !== true) {
      print(`  ${name}: ${problemOf(res, 'the house refused')}`);
      return 1;
    }
    if (verb === 'wake') {
      const eta = num(res.eta_s);
      print(res.state === 'awake' ? `  ${name} is already awake.`
        : `  ${name} is waking up${eta !== null ? ` -- about ${Math.round(eta)} s` : ''}. `
          + '/posture shows progress.');
    } else {
      print(`  ${name} is going to sleep${typeof res.state === 'string' ? ` (${res.state})` : ''}.`);
    }
    return 0;
  }

  if ((POSTURE_WORDS as readonly string[]).includes(verb)) {
    if (pos.length > 1) { print(POSTURE_USAGE); return 2; }
    if (until && !UNTIL_RE.test(until)) {
      print(`  until ${until}: a clock time (21:30), an ISO date-time or a span (2h, 90m)`);
      return 2;
    }
    const word = verb as PostureWord;
    const body: Rec = { word };
    if (until) body.until = until;
    const res = await safeCall(call, 'fleet_posture_set', body);
    if (json) { print(JSON.stringify(res, null, 2)); return isRec(res) && res.ok === true ? 0 : 1; }
    if (!isRec(res) || res.ok !== true) {
      print(`  ${POSTURE_LABELS[word]}: ${problemOf(res, 'the house refused')}`);
      return 1;
    }
    if (cachePath) {
      // The bar shows the new word at once; the next refresh confirms it.
      const now = Date.now() / 1000;
      try {
        writePostureCache({ label: POSTURE_LABELS[word], surfacesDown: [], fetched_at: now,
          attempted_at: now, error: null }, cachePath);
      } catch { /* the bar catches up on its own refresh */ }
    }
    print(res.pending === true
      ? `  ${POSTURE_LABELS[word]} -- still applying; /posture shows the result.`
      : `  House is now ${POSTURE_LABELS[word]}${until ? ` until ${until}` : ''}.`);
    return 0;
  }

  print(POSTURE_USAGE);
  return 2;
}
