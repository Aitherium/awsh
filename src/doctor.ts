/**
 * doctor.ts -- `awsh doctor`: can this shell work here, and does it stay on this machine?
 *
 * The verdict is PURE over injected probes (runDoctor), so each outcome is testable
 * without a network. Exit codes: 0 pass, 1 fail, 2 could not judge. A probe that
 * crashed or could not run is 'unknown' -- never a pass.
 *
 * Strict mode applies when the shell is offline or the machine ships the vendor config
 * (/usr/lib/awsh/shell.yaml, an awnix image): then every check is required, and the
 * verdict matches `awnix awsh doctor`. On an ordinary desktop the offline/local checks
 * are reported as advisory, so a cloud-using install is not called broken.
 *
 * The doctor never dials an address outside this machine: every probe url is checked
 * for loopback first, and a non-loopback one is listed in `nonloopback_urls` instead.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackUrl, isOffline, loadLayeredConfig, type LayeredConfig } from './offline.js';

export type Verdict = 'pass' | 'fail' | 'unknown';

export interface DoctorCheck {
  id: string;
  ok: boolean | null;
  detail: string;
  required: boolean;
}

export interface DoctorReport {
  schema: 1;
  verdict: Verdict;
  offline: boolean;
  strict: boolean;
  checks: DoctorCheck[];
  nonloopback_urls: string[];
  llm_url: string | null;
  model: string | null;
  harness_bind: string | null;
}

export interface Listener { address: string; port: number }

export interface DoctorProbes {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  home: string;
  loadConfig: () => LayeredConfig;
  /** GET a LOOPBACK url; status null = nothing answered. */
  getJson: (url: string) => Promise<{ status: number | null; body: unknown }>;
  /** TCP LISTEN sockets, or null when the table cannot be read. */
  listeners: () => Promise<Listener[] | null>;
  /** File mode bits, or null when the file does not exist. */
  fileMode: (path: string) => number | null;
  platform: NodeJS.Platform;
}

export const DOCTOR_EXIT: Record<Verdict, number> = { pass: 0, fail: 1, unknown: 2 };

export const DEFAULT_LLM_URL = 'http://127.0.0.1:8199/v1';
export const DEFAULT_HARNESS_URL = 'http://127.0.0.1:8362';

/** Environment variable -> config key; the environment is the top layer. */
export const ENV_KEYS: [string, string][] = [
  ['AITHER_OFFLINE', 'offline'],
  ['AITHER_INFERENCE_MODE', 'inference_mode'],
  ['AITHER_LLM_URL', 'llm_url'],
  ['AITHER_API_URL', 'api_url'],
  ['AITHER_GENESIS_URL', 'genesis_url'],
  ['AITHER_GATEWAY_URL', 'gateway_url'],
  ['AITHER_MCP_URL', 'mcp_url'],
  ['AITHER_IDENTITY_URL', 'identity_url'],
  ['AITHER_HARNESS_URL', 'harness_url'],
];

function withEnv(cfg: LayeredConfig, env: NodeJS.ProcessEnv): { values: Record<string, string>; sources: Record<string, string> } {
  const values = { ...cfg.values };
  const sources = { ...cfg.sources };
  for (const [name, key] of ENV_KEYS) {
    const v = (env[name] || '').trim();
    if (v) { values[key] = v; sources[key] = `env:${name}`; }
  }
  return { values, sources };
}

function portOf(url: string, dflt: number): number {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : dflt;
  } catch { return dflt; }
}

function isLoopbackHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

export async function runDoctor(p: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const egress: string[] = [];
  const add = (id: string, ok: boolean | null, detail: string, required = true) =>
    checks.push({ id, ok, detail, required });

  const major = Number(/^v?(\d+)/.exec(p.nodeVersion)?.[1] ?? 0);
  add('node', major >= 18, `node ${p.nodeVersion} (need >= 18)`);

  let cfg: LayeredConfig;
  try {
    cfg = p.loadConfig();
  } catch (err: any) {
    add('config', null, `config layers could not be read: ${err?.message || err}`);
    return finish(checks, egress, false, false, null, null, null);
  }
  if (cfg.unreadable.length) {
    add('config', null, `unreadable config layer(s): ${cfg.unreadable.join(', ')}`);
  } else {
    const present = cfg.layers.filter((l) => l.present).map((l) => l.path);
    add('config', true, present.length ? `layers: ${present.join(', ')}` : 'no config files (defaults)');
  }
  const { values, sources } = withEnv(cfg, p.env);
  const offline = isOffline(p.env, cfg.values);
  const vendor = cfg.layers.some((l) => l.present && /usr[\\/]lib[\\/]awsh[\\/]shell\.yaml$/.test(l.path));
  const strict = offline || vendor;

  add('offline', offline, offline
    ? 'offline mode is on (no cloud rung, no cloud failover)'
    : 'offline is not set: with no local backend awsh falls back to a cloud gateway', strict);

  const bad: string[] = [];
  for (const key of Object.keys(values).sort()) {
    if (/_url$/.test(key) && values[key] && !isLoopbackUrl(values[key])) {
      bad.push(`${key}=${values[key]} (${sources[key] || '?'})`);
      egress.push(values[key]);
    }
  }
  add('loopback-urls', bad.length === 0,
    bad.length ? `non-loopback url(s): ${bad.join('; ')}` : 'every configured url is loopback', strict);

  const llmUrl = (values.llm_url || DEFAULT_LLM_URL).replace(/\/+$/, '');
  let model: string | null = null;
  if (!isLoopbackUrl(llmUrl)) {
    add('local-llm', false, `llm_url ${llmUrl} is not loopback; not dialed`, strict);
  } else {
    try {
      const r = await p.getJson(`${llmUrl}/models`);
      const data = (r.body as { data?: { id?: string }[] } | null)?.data;
      if (r.status === null) add('local-llm', false, `nothing answers ${llmUrl}/models`, strict);
      else if (r.status !== 200) add('local-llm', false, `${llmUrl}/models answered HTTP ${r.status}`, strict);
      else if (Array.isArray(data) && data.length && data[0]?.id) {
        model = String(data[0].id);
        add('local-llm', true, `${llmUrl} serves ${model}`, strict);
      } else add('local-llm', false, `${llmUrl}/models lists no model`, strict);
    } catch (err: any) {
      add('local-llm', null, `probe crashed: ${err?.message || err}`, strict);
    }
  }

  const harnessUrl = (values.harness_url || DEFAULT_HARNESS_URL).replace(/\/+$/, '');
  const hport = portOf(harnessUrl, 8362);
  let harnessBind: string | null = null;
  try {
    const table = await p.listeners();
    if (table === null) {
      add('harness-bind', null, `listener table unreadable; bind of :${hport} not judged`, strict);
    } else {
      const binds = [...new Set(table.filter((l) => l.port === hport)
        .map((l) => (l.address.includes(':') ? `[${l.address}]` : l.address) + `:${l.port}`))].sort();
      if (!binds.length) {
        add('harness-bind', false, `nothing listens on :${hport}`, strict);
      } else {
        harnessBind = binds.join(',');
        const loop = binds.every((b) => isLoopbackHost(b.slice(0, b.lastIndexOf(':'))));
        add('harness-bind', loop, loop ? `harness bound ${harnessBind}`
          : `harness bound ${harnessBind}: not loopback-only`, strict);
      }
    }
  } catch (err: any) {
    add('harness-bind', null, `probe crashed: ${err?.message || err}`, strict);
  }

  if (isLoopbackUrl(harnessUrl)) {
    try {
      const r = await p.getJson(`${harnessUrl}/health`);
      add('harness-health', r.status === 200, `${harnessUrl}/health -> ${r.status ?? 'no answer'}`, strict);
    } catch (err: any) {
      add('harness-health', null, `probe crashed: ${err?.message || err}`, strict);
    }
  } else {
    add('harness-health', false, `harness_url ${harnessUrl} is not loopback; not dialed`, strict);
  }

  const token = join(p.home, '.aither', 'harness_token');
  const mode = p.fileMode(token);
  if (mode === null) add('harness-token', false, `${token} missing (awnix awsh first-run)`, strict);
  else if (p.platform !== 'win32' && (mode & 0o077) !== 0) {
    add('harness-token', false, `${token} is mode ${(mode & 0o777).toString(8)}; must be 600`, strict);
  } else add('harness-token', true, `${token} present`, strict);

  return finish(checks, egress, offline, strict, llmUrl, model, harnessBind);
}

function finish(checks: DoctorCheck[], egress: string[], offline: boolean, strict: boolean,
  llmUrl: string | null, model: string | null, harnessBind: string | null): DoctorReport {
  const req = checks.filter((c) => c.required);
  const verdict: Verdict = req.some((c) => c.ok === false) ? 'fail'
    : req.some((c) => c.ok === null) ? 'unknown' : 'pass';
  return {
    schema: 1, verdict, offline, strict, checks, nonloopback_urls: egress,
    llm_url: llmUrl, model, harness_bind: harnessBind,
  };
}

/** A report for a doctor that itself crashed: could not judge, never a pass. */
export function crashReport(err: unknown): DoctorReport {
  return finish([{ id: 'doctor', ok: null, detail: `doctor crashed: ${String((err as any)?.message || err)}`, required: true }],
    [], false, false, null, null, null);
}

// ── real probes ────────────────────────────────────────────────────────────

function decodeV4(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  return [b[3], b[2], b[1], b[0]].join('.');
}

function decodeV6(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  const words: string[] = [];
  for (let i = 0; i < 16; i += 4) {
    const w = Buffer.from([b[i + 3], b[i + 2], b[i + 1], b[i]]);
    words.push(w.readUInt16BE(0).toString(16), w.readUInt16BE(2).toString(16));
  }
  const full = words.join(':');
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  if (full === '0:0:0:0:0:0:0:0') return '::';
  return full;
}

/** Parse /proc/net/tcp{,6} text into LISTEN sockets. Exported for tests. */
export function parseProcNet(text: string, v6: boolean): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== '0A') continue;
    const [addr, port] = cols[1].split(':');
    if (!addr || !port) continue;
    out.push({ address: v6 ? decodeV6(addr) : decodeV4(addr), port: parseInt(port, 16) });
  }
  return out;
}

export function defaultProbes(env: NodeJS.ProcessEnv = process.env): DoctorProbes {
  const home = homedir();
  return {
    nodeVersion: process.version,
    env,
    home,
    platform: process.platform,
    loadConfig: () => loadLayeredConfig({
      home, root: (env.AWSH_CONFIG_ROOT || '').trim() || undefined,
    }),
    getJson: async (url: string) => {
      if (!isLoopbackUrl(url)) throw new Error(`refusing to dial non-loopback ${url}`);
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        let body: unknown = null;
        try { body = await r.json(); } catch { body = null; }
        return { status: r.status, body };
      } catch { return { status: null, body: null }; }
    },
    listeners: async () => {
      if (process.platform !== 'linux') return null;
      const dir = (env.AWSH_PROC_NET || '/proc/net').trim();
      let seen = false;
      const out: Listener[] = [];
      for (const [name, v6] of [['tcp', false], ['tcp6', true]] as const) {
        try {
          out.push(...parseProcNet(readFileSync(join(dir, name), 'utf-8'), v6));
          seen = true;
        } catch { /* absent table (no IPv6) */ }
      }
      return seen ? out : null;
    },
    fileMode: (path: string) => {
      try { return statSync(path).mode; } catch { return null; }
    },
  };
}

export function printDoctor(rep: DoctorReport): void {
  const mark = (ok: boolean | null) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  ');
  for (const c of rep.checks) {
    console.log(`  [${mark(c.ok)}] ${c.id.padEnd(15)} ${c.detail}${c.required ? '' : ' (advisory)'}`);
  }
  console.log(`  verdict: ${rep.verdict.toUpperCase()}${rep.strict ? '' : '  (desktop: offline checks advisory)'}`);
}
