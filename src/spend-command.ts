/**
 * `/spend [24h|7d|30d]` and the status-bar `$X.XX/24h` segment — cloud LLM spend
 * (DeepSeek and kin) in the terminal.
 *
 * Source: the gateway MCP tool `cloud_spend {hours}` (MicroScheduler `/cloud/spend`
 * behind it), asked on the LOCAL gateway `127.0.0.1:8182/mcp` with the session
 * bearer `~/.aither/session-bearer` — the same pair the Claude Code statusline and
 * `adk spend` use. `AITHER_SPEND_MCP_URL` overrides the URL.
 *
 * The status bar never waits on the network: it reads `~/.aither/spend-cache.json`
 * (the file `tools/claude-backend/aither_spend_cache.py` writes, same shape) and, when
 * that is older than a minute, refreshes it in the background for the next paint.
 *
 * Never fake zeros: a failed or off-contract answer prints `spend unavailable: <why>`
 * and the bar shows nothing — a dollar figure is only ever one somebody measured.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpHttpClient, type McpCallResult } from './mcp-client.js';

export interface SpendModel {
  model: string; usd: number; prompt_tokens: number; completion_tokens: number; requests: number;
}
export interface SpendProvider {
  provider: string; usd: number; prompt_tokens: number; completion_tokens: number;
  requests: number; failed: number; models: SpendModel[];
}
export interface SpendSource { source: string; usd: number; requests: number; tokens: number; }
export interface SpendBalance {
  available: boolean; total_balance: string | null; currency?: string | null;
  checked_at?: string | null; error?: string | null;
}
export interface SpendReport {
  window_hours: number;
  generated_at?: string;
  total_usd: number;
  unpriced_requests?: number;
  providers: SpendProvider[];
  top_sources?: SpendSource[];
  balance?: Record<string, SpendBalance>;
}

/** Shape of ~/.aither/spend-cache.json (shared with aither_spend_cache.py). */
export interface SpendCache {
  data: SpendReport | null;
  fetched_at: number | null;   // epoch SECONDS of the last good answer
  attempted_at: number | null; // epoch seconds of the last try, good or bad
  error: string | null;
}

export const SPEND_MCP_URL = (process.env.AITHER_SPEND_MCP_URL || 'http://127.0.0.1:8182/mcp');
const AITHER_HOME = process.env.AITHER_HOME || join(homedir(), '.aither');
export const SPEND_CACHE_PATH = join(AITHER_HOME, 'spend-cache.json');
const BEARER_PATH = join(AITHER_HOME, 'session-bearer');
export const REFRESH_EVERY_S = 60;
const SHOW_AGE_AFTER_S = 600;
const HIDE_AFTER_S = 6 * 3600;

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function lowBalanceThreshold(): number {
  return num(process.env.AITHER_SPEND_LOW_USD) ?? 5;
}

/** The report when it carries the contract's load-bearing fields, else null. An error
 *  envelope or `{}` is NOT a zero-dollar day. */
export function validateSpend(data: unknown): SpendReport | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.error) return null;
  if (num(d.total_usd) === null || !Array.isArray(d.providers)) return null;
  return d as unknown as SpendReport;
}

/** `24h` | `7d` | `30d` | `48` (hours) → hours; null for anything else. */
export function parseSpendWindow(arg: string): number | null {
  const a = arg.trim().toLowerCase();
  if (!a) return 24;
  const m = /^(\d+)\s*([hd]?)$/.exec(a);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
  return n >= 1 && n <= 24 * 90 ? n : null;
}

export function windowLabel(hours: unknown): string {
  const h = num(hours) ?? 24;
  return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

const usd = (v: unknown) => { const n = num(v); return n === null ? '$?' : `$${n.toFixed(2)}`; };
const int = (v: unknown) => { const n = num(v); return n === null ? '?' : Math.round(n).toLocaleString('en-US'); };

export function deepseekBalance(data: SpendReport): number | null {
  const b = data.balance?.deepseek;
  if (!b || !b.available) return null;
  return num(b.total_balance);
}

/** `$X.XX/24h`, plus `ds $B low` when the DeepSeek balance is under the threshold. */
export function formatSpendSegment(data: SpendReport, lowUsd = lowBalanceThreshold()): string {
  const total = num(data.total_usd);
  if (total === null) return '';
  let text = `$${total.toFixed(2)}/${windowLabel(data.window_hours)}`;
  const bal = deepseekBalance(data);
  if (bal !== null && bal < lowUsd) text += ` ds $${bal.toFixed(2)} low`;
  return text;
}

/** The full `/spend` report, plain text lines. */
export function formatSpendReport(data: SpendReport): string[] {
  const out: string[] = [];
  const gen = String(data.generated_at || '').slice(0, 16).replace('T', ' ');
  out.push(`Cloud LLM spend — last ${windowLabel(data.window_hours)}${gen ? `  (as of ${gen}Z)` : ''}`);
  let total = `Total  ${usd(data.total_usd)}`;
  const unpriced = num(data.unpriced_requests) ?? 0;
  if (unpriced) total += `   + ${int(unpriced)} unpriced request(s) NOT in the total`;
  out.push(total);
  const providers = [...(data.providers || [])].sort((a, b) => (num(b.usd) ?? 0) - (num(a.usd) ?? 0));
  if (!providers.length) out.push('  (no cloud requests in this window)');
  for (const p of providers) {
    const failed = num(p.failed) ?? 0;
    out.push('');
    out.push(`  ${String(p.provider || '?').padEnd(26)} ${usd(p.usd).padStart(10)}  ${int(p.requests).padStart(7)} req`
      + `${failed ? ` (${int(failed)} failed)` : ''}  ${int(p.prompt_tokens)} in / ${int(p.completion_tokens)} out tok`);
    const models = [...(p.models || [])].sort((a, b) => (num(b.usd) ?? 0) - (num(a.usd) ?? 0));
    for (const m of models) {
      out.push(`    ${String(m.model || '?').padEnd(24)} ${usd(m.usd).padStart(10)}  ${int(m.requests).padStart(7)} req`
        + `  ${int(m.prompt_tokens)} in / ${int(m.completion_tokens)} out tok`);
    }
  }
  const sources = data.top_sources || [];
  if (sources.length) {
    out.push('', '  Top callers');
    for (const s of sources.slice(0, 10)) {
      out.push(`    ${String(s.source || '?').padEnd(32)} ${usd(s.usd).padStart(10)}  ${int(s.requests).padStart(7)} req  ${int(s.tokens)} tok`);
    }
  }
  out.push('');
  const bal = data.balance || {};
  const names = Object.keys(bal).sort();
  if (!names.length) out.push('  Balance  not reported');
  for (const name of names) {
    const b = bal[name];
    const label = name === 'deepseek' ? 'DeepSeek' : name;
    const amount = num(b?.total_balance);
    if (b?.available && amount !== null) {
      const checked = String(b.checked_at || '').slice(11, 16);
      out.push(`  ${label} balance  ${amount.toFixed(2)} ${b.currency || ''}${checked ? `  (checked ${checked}Z)` : ''}`);
    } else {
      out.push(`  ${label} balance  unavailable${b?.error ? `: ${String(b.error).slice(0, 80)}` : ''}`);
    }
  }
  return out;
}

// ── cache (shared with the Claude Code statusline) ────────────────────────────

export function readSpendCache(path = SPEND_CACHE_PATH): SpendCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as SpendCache : null;
  } catch {
    return null;
  }
}

export function writeSpendCache(cache: SpendCache, path = SPEND_CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
  renameSync(tmp, path);
}

/** Status-bar text from a cache: '' (hide) unless it holds measured numbers. */
export function segmentFromCache(cache: SpendCache | null, nowS = Date.now() / 1000,
  lowUsd = lowBalanceThreshold()): { text: string; low: boolean } {
  const data = validateSpend(cache?.data);
  const fetched = num(cache?.fetched_at);
  if (!data || fetched === null) return { text: '', low: false };
  const age = nowS - fetched;
  if (age > HIDE_AFTER_S) return { text: '', low: false };
  let text = formatSpendSegment(data, lowUsd);
  if (!text) return { text: '', low: false };
  if (age > SHOW_AGE_AFTER_S) {
    text += age < 3600 ? ` (${Math.floor(age / 60)}m)` : ` (${Math.floor(age / 3600)}h)`;
  }
  return { text, low: text.includes(' low') };
}

export function cacheNeedsRefresh(cache: SpendCache | null, nowS = Date.now() / 1000): boolean {
  if (!cache) return true;
  const last = num(cache.attempted_at) ?? num(cache.fetched_at) ?? 0;
  return nowS - last >= REFRESH_EVERY_S;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

export type SpendFetcher = (hours: number) => Promise<SpendReport>;

/** The JSON a tools/call result carries (structuredContent, else the text part). */
export function toolPayload(result: McpCallResult | null | undefined): unknown {
  if (!result) return null;
  const texts = (result.content || []).filter(c => c?.type === 'text').map(c => c.text || '');
  if (result.isError) return { error: texts.join(' ').slice(0, 300) || 'tool error' };
  const sc = result.structuredContent;
  if (sc && typeof sc === 'object' && Object.keys(sc).length) {
    const keys = Object.keys(sc);
    return keys.length === 1 && keys[0] === 'result' ? sc.result : sc;
  }
  for (const t of texts) {
    try { return JSON.parse(t); } catch { return { error: t.slice(0, 300) }; }
  }
  return null;
}

function readBearer(): string {
  const env = (process.env.AITHER_MCP_KEY || '').trim();
  if (env) return env;
  try { return readFileSync(BEARER_PATH, 'utf-8').trim(); } catch { return ''; }
}

/** Ask `cloud_spend` on the local gateway. Throws with a human reason on anything else. */
export const fetchSpend: SpendFetcher = async (hours: number) => {
  const bearer = readBearer();
  if (!bearer) {
    throw new Error('no gateway bearer (~/.aither/session-bearer); re-mint with mint_session_bearer.py');
  }
  const client = new McpHttpClient(SPEND_MCP_URL, bearer);
  const result = await client.callTool('cloud_spend', { hours });
  const payload = toolPayload(result);
  const data = validateSpend(payload);
  if (!data) {
    const why = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error) : JSON.stringify(payload);
    throw new Error(`cloud_spend gave no spend report: ${why}`.slice(0, 300));
  }
  return data;
};

/** Fetch once and record the outcome; a failure keeps the last good numbers + their age. */
export async function refreshSpendCache(fetch: SpendFetcher = fetchSpend,
  path = SPEND_CACHE_PATH, nowS = Date.now() / 1000): Promise<SpendCache> {
  const prior = readSpendCache(path);
  const cache: SpendCache = {
    data: prior?.data ?? null, fetched_at: prior?.fetched_at ?? null, attempted_at: nowS, error: null,
  };
  try {
    cache.data = await fetch(24);
    cache.fetched_at = nowS;
  } catch (e: unknown) {
    cache.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  try { writeSpendCache(cache, path); } catch { /* an unwritable cache costs the next paint a fetch */ }
  return cache;
}

let refreshing: Promise<SpendCache> | null = null;

/** Status-bar segment: reads the cache NOW, kicks a background refresh when stale. */
export function spendBarSegment(fetch: SpendFetcher = fetchSpend,
  path = SPEND_CACHE_PATH): { text: string; low: boolean } {
  const cache = readSpendCache(path);
  if (cacheNeedsRefresh(cache) && !refreshing) {
    refreshing = refreshSpendCache(fetch, path).finally(() => { refreshing = null; });
    refreshing.catch(() => { /* recorded in the cache */ });
  }
  return segmentFromCache(cache);
}

// ── the command ───────────────────────────────────────────────────────────────

export interface SpendDeps {
  fetch?: SpendFetcher;
  print?: (line: string) => void;
  cachePath?: string | null;  // null = do not write the shared cache
}

export async function runSpendCommand(args: string[], deps: SpendDeps = {}): Promise<number> {
  const print = deps.print || ((l: string) => console.log(l));
  const json = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('--'));
  const hours = parseSpendWindow(positional[0] || '');
  if (hours === null) {
    print('usage: /spend [24h|7d|30d] [--json]');
    return 2;
  }
  let data: SpendReport;
  try {
    data = await (deps.fetch || fetchSpend)(hours);
  } catch (e: unknown) {
    print(`spend unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const cachePath = deps.cachePath === undefined ? SPEND_CACHE_PATH : deps.cachePath;
  if (hours === 24 && cachePath) {
    const now = Date.now() / 1000;
    try {
      writeSpendCache({ data, fetched_at: now, attempted_at: now, error: null }, cachePath);
    } catch { /* the report printed; the bar catches up on its own refresh */ }
  }
  if (json) {
    print(JSON.stringify(data, null, 2));
    return 0;
  }
  print('');
  for (const line of formatSpendReport(data)) print('  ' + line);
  print('');
  return 0;
}

