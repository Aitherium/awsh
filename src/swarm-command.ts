/**
 * `awsh swarm <list|status|launch|steer|pause|resume|cancel|delegate|board|post|nudge|capacity>`
 *
 * Drives Genesis's live SwarmBoardEngine or the local Room-backed SwarmBoard
 * via the local awsh harness daemon (:8362 `/swarms/*`), with fail-closed auth
 * (`AITHER_HARNESS_TOKEN` / `~/.aither/harness_token`, never printing secrets).
 * Also lets the owner delegate a SwarmBoard worker slot directly to a local
 * coding harness (`claude`, `codex`, `gemini`, `aither`, `awdk`).
 */

import { api as daemonApi, daemonToken, daemonUrl } from './harness-client.js';

export type SwarmAction =
  | 'list'
  | 'status'
  | 'launch'
  | 'steer'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'delegate'
  | 'board'
  | 'post'
  | 'nudge'
  | 'capacity'
  | 'help';

export const SWARM_ACTIONS: readonly SwarmAction[] = [
  'list',
  'status',
  'launch',
  'steer',
  'pause',
  'resume',
  'cancel',
  'delegate',
  'board',
  'post',
  'nudge',
  'capacity',
  'help',
];

export const SWARM_HARNESSES = ['claude', 'codex', 'gemini', 'aither', 'awdk'] as const;

export interface ParsedSwarmCommand {
  action: SwarmAction;
  positional: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
}

export interface SwarmCommandDeps {
  api?: <T>(path: string, init?: RequestInit) => Promise<T>;
  hasToken?: () => boolean;
  log?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
}

const VALUE_FLAGS = new Set([
  'status',
  'limit',
  'leads',
  'coordinator',
  'title',
  'effort',
  'reason',
  'harness',
  'agent',
  'cwd',
  'model-profile',
  'thread',
  'report-to',
  'timeout',
  'workers',
  'pools',
  'slot',
  'slot-id',
  'member-id',
  'pool',
  'owns',
  'must-not-touch',
  'room-id',
  'mode',
  'since',
  'kind',
  'mentions',
  'artifact-dir',
  'key-path',
  'escalate-after',
  'export-dir',
  'execution-mode',
  'limits',
  'egress',
  'isolation',
  'awseal-expect-key',
  'inference-runtime',
  'model-path',
  'model-sha256',
  'cpu-pin',
]);

export function parseSwarmArgs(argv: string[]): ParsedSwarmCommand | null {
  const args = [...argv];
  if (!args.length) {
    return { action: 'list', positional: [], flags: {}, json: false };
  }
  const head = args[0].toLowerCase();
  if (head === '-h' || head === '--help' || head === 'help') {
    return { action: 'help', positional: [], flags: {}, json: false };
  }
  let action: SwarmAction = 'list';
  let idx = 0;
  if (!head.startsWith('-')) {
    if (!(SWARM_ACTIONS as readonly string[]).includes(head)) return null;
    action = head as SwarmAction;
    idx = 1;
  }
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let json = false;
  for (let i = idx; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--json') {
      json = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 2) {
        const k = tok.slice(2, eq).toLowerCase();
        flags[k] = tok.slice(eq + 1);
      } else {
        const k = tok.slice(2).toLowerCase();
        if (VALUE_FLAGS.has(k)) {
          const next = args[i + 1];
          if (next === undefined || next.startsWith('--')) {
            throw new CliInputError(`Missing value for --${k}.`);
          }
          flags[k] = next;
          i++;
        } else {
          flags[k] = true;
        }
      }
      continue;
    }
    positional.push(tok);
  }
  return { action, positional, flags, json };
}

export function swarmUsage(): string {
  return [
    'awsh swarm — drive live multi-agent Swarms & local harness workers',
    '',
    '  awsh swarm list [--status live|stalled|paused|done] [--limit N] [--local] [--json]',
    '  awsh swarm status [swarm_id] [--json]      inspect a swarm (or local Swarm capacity)',
    '  awsh swarm launch <goal…> [--leads atlas,demi] [--workers JSON|a,b] [--pools fix=3]',
    '                            [--owns a,b] [--must-not-touch c] [--worktree] [--leases]',
    '                            [--local] [--room-id R] [--mode local] [--coordinator aither]',
    '                            [--execution-mode inline|standard|awrun] [--limits JSON]',
    '                            [--egress host1,host2|JSON] [--isolation JSON]',
    '                            [--awseal-expect-key HEX] [--seal-artifacts]',
    '                            [--inference-runtime standard|asm-llm|awzeal] [--shared-ro-mmap]',
    '                            [--model-path P] [--model-sha256 H] [--cpu-pin MASK]',
    '                            [--title T] [--effort 7] [--json]',
    '  awsh swarm board <swarm_id> [--since N] [--limit N] [--json]',
    '  awsh swarm post <swarm_id> <text…> [--agent A] [--slot S] [--kind K] [--mentions a,b]',
    '                            [--thread T] [--artifact-dir D] [--seal-artifacts]',
    '                            [--awseal-expect-key HEX] [--key-path P] [--local] [--no-keep-warm]',
    '  awsh swarm steer <swarm_id> <message…> [--mentions a,b]',
    '  awsh swarm nudge <swarm_id> [<slot_id>] [<reason…>] [--slot S] [--thread T]',
    '                            [--escalate-after S] [--force-escalate]',
    '  awsh swarm pause <swarm_id> [--reason R] [--export-runs] [--export-dir D]',
    '  awsh swarm resume <swarm_id>',
    '  awsh swarm cancel <swarm_id> [--reason R] [--export-runs] [--export-dir D]',
    '  awsh swarm delegate <swarm_id> --harness claude|codex|gemini|aither|awdk',
    '                      --agent <lead> [--slot S] [--member-id M] [--pool P]',
    '                      [--owns a,b] [--must-not-touch c] [--worktree] [--leases]',
    '                      [--no-keep-warm] [--local] [--timeout S] [--wait]',
    '                      [--execution-mode awrun] [--limits JSON] [--egress ...] [--isolation JSON]',
    '                      [--inference-runtime standard|asm-llm|awzeal] [--shared-ro-mmap]',
    '                      [--model-path P] [--model-sha256 H] [--cpu-pin MASK] <prompt…>',
    '  awsh swarm capacity [--no-probe] [--json]  show local harness & live Genesis reachability',
    '',
    '  Env: AITHER_SWARM_API_URL overrides the SwarmBoard API base URL (defaults to',
    '       AITHER_GENESIS_URL or the control-plane Genesis bridge, never localhost:8001).',
  ].join('\n');
}

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

function strFlag(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (v === true) {
    throw new CliInputError(`Missing value for --${key}.`);
  }
  return typeof v === 'string' ? v.trim() : '';
}

function boolFlag(flags: Record<string, string | boolean>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = flags[key];
    if (v === undefined) continue;
    if (typeof v === 'boolean') return v;
    const low = v.trim().toLowerCase();
    if (low === '' || low === 'true' || low === '1' || low === 'yes' || low === 'on') return true;
    if (low === 'false' || low === '0' || low === 'no' || low === 'off') return false;
    throw new CliInputError(`Invalid boolean value for --${key}: ${v}`);
  }
  return undefined;
}

function splitCsv(raw: string): string[] {
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitMentions(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^@+/, ''))
    .filter(Boolean);
}

function parseJsonObjectFlag(raw: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new CliInputError(`Invalid JSON for --${flagName}: ${e?.message || e}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliInputError(`--${flagName} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseEgressFlag(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonObjectFlag(trimmed, 'egress');
  }
  const hosts = splitCsv(trimmed);
  return { hosts };
}

function parseWorkersFlag(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e: any) {
      throw new CliInputError(`Invalid JSON for --workers: ${e?.message || e}`);
    }
    if (!Array.isArray(parsed)) {
      throw new CliInputError('--workers JSON must be an array.');
    }
    return parsed;
  }
  return splitMentions(trimmed).map((slot) => ({ slot_id: slot, agent: slot }));
}

function parsePoolsFlag(
  raw: string,
  owns: string[],
  mustNotTouch: string[],
): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonObjectFlag(trimmed, 'pools');
  }
  const out: Record<string, unknown> = {};
  for (const part of splitCsv(trimmed)) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new CliInputError(`Invalid --pools entry "${part}". Expected name=count or JSON.`);
    }
    const name = part.slice(0, eq).trim();
    const countRaw = part.slice(eq + 1).trim();
    const count = Number(countRaw);
    if (!name || !Number.isInteger(count) || count < 1) {
      throw new CliInputError(`Invalid --pools count for "${name}": ${countRaw}`);
    }
    if (owns.length || mustNotTouch.length) {
      out[name] = {
        count,
        ...(owns.length ? { owns } : {}),
        ...(mustNotTouch.length ? { must_not_touch: mustNotTouch } : {}),
      };
    } else {
      out[name] = count;
    }
  }
  if (!Object.keys(out).length) {
    throw new CliInputError('--pools requires at least one pool entry.');
  }
  return out;
}

function parseNumFlag(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliInputError(`Invalid number for --${flagName}: ${raw}`);
  }
  return n;
}

function applyF16Flags(
  flags: Record<string, string | boolean>,
  body: Record<string, unknown>,
): void {
  const execMode = strFlag(flags, 'execution-mode');
  if (execMode) body.execution_mode = execMode;

  const limitsRaw = strFlag(flags, 'limits');
  if (limitsRaw) body.limits = parseJsonObjectFlag(limitsRaw, 'limits');

  const egressRaw = strFlag(flags, 'egress');
  if (egressRaw) body.egress = parseEgressFlag(egressRaw);

  const isolationRaw = strFlag(flags, 'isolation');
  if (isolationRaw) body.isolation = parseJsonObjectFlag(isolationRaw, 'isolation');

  const expectKey = strFlag(flags, 'awseal-expect-key');
  if (expectKey) body.awseal_expect_key = expectKey;

  const sealArtifacts = boolFlag(flags, 'seal-artifacts');
  if (sealArtifacts !== undefined) body.seal_artifacts = sealArtifacts;

  const infRuntime = strFlag(flags, 'inference-runtime');
  if (infRuntime) body.inference_runtime = infRuntime;

  const sharedRo = boolFlag(flags, 'shared-ro-mmap');
  if (sharedRo !== undefined) body.shared_ro_mmap = sharedRo;

  const modelPath = strFlag(flags, 'model-path');
  if (modelPath) body.model_path = modelPath;

  const modelSha = strFlag(flags, 'model-sha256');
  if (modelSha) body.model_sha256 = modelSha;

  const cpuPin = strFlag(flags, 'cpu-pin');
  if (cpuPin) body.cpu_pin = cpuPin;
}

export function formatSwarmList(data: any): string {
  const rows: any[] = Array.isArray(data?.swarms) ? data.swarms : [];
  const lines: string[] = [];
  if (!rows.length) {
    lines.push('No swarms found.');
  } else {
    for (const r of rows) {
      const sid = String(r?.swarm_id || '?');
      const st = String(r?.status || '?').padEnd(8);
      const localBadge = r?.local_room ? ' [local]' : '';
      const title = String(r?.title || r?.goal?.title || 'Untitled').slice(0, 64);
      const prog = r?.overview?.progress || r?.progress;
      const done = prog ? `${prog.done ?? 0}/${prog.total ?? 0}` : '';
      const ui = r?.ui_url ? `  ${r.ui_url}` : '';
      lines.push(`  ${sid}  [${st.trim()}]${localBadge}${done ? ` (${done})` : ''}  ${title}${ui}`);
    }
  }
  const cap = data?.capacity;
  if (cap) {
    const hs = Array.isArray(cap.swarm_harnesses) && cap.swarm_harnesses.length
      ? cap.swarm_harnesses.join(', ')
      : 'none detected';
    const awrunBit = cap.awrun_available !== undefined
      ? ` | awrun: ${cap.awrun_available ? 'on' : 'off'}`
      : '';
    lines.push(`Local harnesses (${cap.node || 'host'}): ${hs}${awrunBit} | UI: ${cap.ui_url || data?.ui_url || 'https://app.aitherium.com/swarm'}`);
  }
  return lines.join('\n');
}

function formatMemberBrief(m: any): string {
  const slot = String(m?.slot_id || m?.name || '?');
  const st = String(m?.session_state || m?.state || '?');
  const bits: string[] = [];
  if (m?.pool) bits.push(`pool=${m.pool}`);
  if (Array.isArray(m?.owns) && m.owns.length) bits.push(`owns=${m.owns.join(',')}`);
  if (Array.isArray(m?.must_not_touch) && m.must_not_touch.length) {
    bits.push(`must_not_touch=${m.must_not_touch.join(',')}`);
  }
  if (Array.isArray(m?.sibling_digests) && m.sibling_digests.length) {
    bits.push(`siblings=${m.sibling_digests.length}`);
  }
  if (m?.worktree_path) bits.push(`wt=${m.worktree_path}`);
  const leases = Array.isArray(m?.lease_ids) && m.lease_ids.length
    ? m.lease_ids
    : (m?.lease_id ? [m.lease_id] : []);
  if (leases.length) bits.push(`leases=${leases.join(',')}`);
  if (m?.execution_mode && m.execution_mode !== 'standard') bits.push(`exec=${m.execution_mode}`);
  if (m?.run_id) bits.push(`run=${m.run_id}`);
  if (m?.inference_runtime && m.inference_runtime !== 'standard') bits.push(`rt=${m.inference_runtime}`);
  if (m?.shared_ro_mmap) bits.push(m?.shared_ro_mode || 'D5_shared_ro');
  if (m?.cpu_pin !== undefined && m?.cpu_pin !== null && m?.cpu_pin !== '') bits.push(`cpu=${m.cpu_pin}`);
  return bits.length ? `${slot}(${st}; ${bits.join(' ')})` : `${slot}(${st})`;
}

export function formatSwarmStatus(view: any): string {
  const sid = String(view?.swarm_id || '?');
  const title = String(view?.title || view?.goal?.title || 'Untitled');
  const status = String(view?.status || 'unknown');
  const prog = view?.overview?.progress || view?.progress;
  const done = prog ? `${prog.done ?? 0}/${prog.total ?? 0}` : '?';
  const modeTag = view?.local_room ? '  |  Mode: local-room' : '';
  const members: string[] = (Array.isArray(view?.members) ? view.members : []).map(formatMemberBrief);
  const lines = [
    `Swarm ${sid} — ${title}`,
    `  Status:   ${status}  |  Progress: ${done}${modeTag}`,
  ];
  if (members.length) lines.push(`  Team:     ${members.join(', ')}`);
  const threads: any[] = Array.isArray(view?.threads) ? view.threads : [];
  for (const th of threads) {
    const tSlot = String(th?.slot_id || th?.owner || th?.id || '?');
    const tBits: string[] = [];
    if (th?.pool) tBits.push(`pool=${th.pool}`);
    if (Array.isArray(th?.owns) && th.owns.length) tBits.push(`owns=${th.owns.join(',')}`);
    if (Array.isArray(th?.must_not_touch) && th.must_not_touch.length) {
      tBits.push(`must_not_touch=${th.must_not_touch.join(',')}`);
    }
    if (Array.isArray(th?.sibling_digests) && th.sibling_digests.length) {
      const sibNames = th.sibling_digests.map((d: any) => (typeof d === 'string' ? d : d?.slot_id || d?.owner || '?'));
      tBits.push(`siblings=[${sibNames.join(',')}]`);
    }
    if (th?.worktree_path) tBits.push(`wt=${th.worktree_path}`);
    const tLeases = Array.isArray(th?.lease_ids) && th.lease_ids.length
      ? th.lease_ids
      : (th?.lease_id ? [th.lease_id] : []);
    if (tLeases.length) tBits.push(`leases=${tLeases.join(',')}`);
    if (th?.run_id) tBits.push(`run=${th.run_id}`);
    if (th?.inference_runtime && th.inference_runtime !== 'standard') tBits.push(`rt=${th.inference_runtime}`);
    if (th?.shared_ro_mmap) tBits.push(th?.shared_ro_mode || 'D5_shared_ro');
    if (th?.cpu_pin !== undefined && th?.cpu_pin !== null && th?.cpu_pin !== '') tBits.push(`cpu=${th.cpu_pin}`);
    if (tBits.length) {
      lines.push(`  Track ${tSlot}: [${th?.status || '?'}] ${tBits.join(' | ')}`);
    }
  }
  if (view?.stall?.active) {
    lines.push(`  STALL:    ${view.stall.message || view.stall.blocking_agent || 'active stall'}`);
  }
  if (view?.ui_url) lines.push(`  Live UI:  ${view.ui_url}`);
  return lines.join('\n');
}

export function formatCapacity(cap: any): string {
  const hs = Array.isArray(cap?.swarm_harnesses) && cap.swarm_harnesses.length
    ? cap.swarm_harnesses.join(', ')
    : 'none';
  const lines = [
    `Swarm capacity on ${cap?.node || 'this machine'}:`,
    `  Harness daemon:  ${cap?.harness_url || daemonUrl()}`,
    `  Swarms API:      ${cap?.genesis_url || ''}${cap?.swarms_endpoint || '/swarms'}`,
    `  Live Swarm UI:   ${cap?.ui_url || 'https://app.aitherium.com/swarm'}`,
    `  Swarm harnesses: ${hs} (sessions ${cap?.active_sessions ?? 0}/${cap?.max_sessions ?? 24})`,
    `  Genesis auth:    ${cap?.auth_configured ? 'configured' : 'missing (fail-closed for writes)'}`,
  ];
  if (
    cap?.awrun_available !== undefined
    || cap?.awseal_available !== undefined
    || cap?.awzeal_available !== undefined
  ) {
    const activeRuns: string[] = Array.isArray(cap?.awrun_active_runs) ? cap.awrun_active_runs : [];
    const runInfo = activeRuns.length
      ? `${activeRuns.length} (${activeRuns.join(', ')})`
      : '0';
    lines.push(
      `  F16 primitives:  awrun=${cap?.awrun_available ? 'yes' : 'no'} (active runs: ${runInfo}) | awseal=${cap?.awseal_available ? 'yes' : 'no'} | awzeal=${cap?.awzeal_available ? 'yes' : 'no'}`,
    );
  }
  if (Array.isArray(cap?.supported_inference_runtimes) && cap.supported_inference_runtimes.length) {
    lines.push(`  Runtimes:        ${cap.supported_inference_runtimes.join(', ')}`);
  }
  if (cap?.genesis) {
    lines.push(
      `  Genesis probe:   ${cap.genesis.reachable ? `reachable (${cap.genesis.count ?? 0} swarms)` : `UNREACHABLE (${cap.genesis.error || cap.genesis.status})`}`,
    );
    if (!cap.genesis.reachable && cap.genesis.hint) {
      lines.push(`  Hint:            ${cap.genesis.hint}`);
    }
  }
  return lines.join('\n');
}

export function formatSwarmBoard(data: any): string {
  const sid = String(data?.swarm_id || '?');
  const posts: any[] = Array.isArray(data?.messages)
    ? data.messages
    : (Array.isArray(data?.posts) ? data.posts : (Array.isArray(data?.board) ? data.board : []));
  const lines = [`Board ${sid} (head #${data?.head ?? data?.last_seq ?? posts.length}, ${posts.length} posts):`];
  if (!posts.length) {
    lines.push('  (empty)');
    return lines.join('\n');
  }
  for (const p of posts) {
    const seq = p?.seq ?? '?';
    const actor = String(p?.slot_id || p?.agent || '?');
    const kind = String(p?.kind || 'update');
    const mentions = Array.isArray(p?.mentions) && p.mentions.length
      ? ` -> @${p.mentions.join(',@')}`
      : '';
    const seal = p?.seal
      ? ` [seal:${p.seal.scheme || (p.seal.verified ? 'verified' : 'unverified')}${p.seal.verified ? ' ok' : ''}]`
      : '';
    const text = String(p?.text || '').replace(/\s+/g, ' ').trim();
    lines.push(`  #${seq} [${kind}] ${actor}${mentions}${seal}: ${text}`);
  }
  return lines.join('\n');
}

export async function runSwarmCommand(argv: string[], deps: SwarmCommandDeps = {}): Promise<number> {
  const log = deps.log || ((line: string) => console.log(line));
  const err = deps.err || ((line: string) => console.error(line));
  let parsed: ParsedSwarmCommand | null;
  try {
    parsed = parseSwarmArgs(argv);
  } catch (e: any) {
    if (e instanceof CliInputError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  if (!parsed) {
    err(swarmUsage());
    return 2;
  }
  if (parsed.action === 'help') {
    log(swarmUsage());
    return 0;
  }
  const hasToken = deps.hasToken ? deps.hasToken() : Boolean(daemonToken());
  if (!hasToken) {
    err('awsh swarm refused (fail-closed): no harness token found. Set AITHER_HARNESS_TOKEN or start `adk harness serve`.');
    return 1;
  }
  const call = deps.api || daemonApi;
  const emit = (payload: any, human: string) => {
    log(parsed.json ? JSON.stringify(payload, null, 2) : human);
  };

  try {
    switch (parsed.action) {
      case 'capacity': {
        const noProbe = parsed.flags['no-probe'] === true;
        const cap = await call<any>(`/swarms/capacity?probe=${noProbe ? 'false' : 'true'}`);
        emit(cap, formatCapacity(cap));
        return 0;
      }
      case 'list': {
        const qs = new URLSearchParams();
        const st = strFlag(parsed.flags, 'status');
        const lim = strFlag(parsed.flags, 'limit');
        const localOnly = boolFlag(parsed.flags, 'local');
        if (st) qs.set('status', st);
        if (lim) qs.set('limit', lim);
        if (localOnly !== undefined) qs.set('local_only', localOnly ? 'true' : 'false');
        const path = qs.toString() ? `/swarms?${qs.toString()}` : '/swarms';
        const data = await call<any>(path);
        emit(data, formatSwarmList(data));
        return 0;
      }
      case 'status': {
        const sid = parsed.positional[0] || '';
        if (!sid) {
          const cap = await call<any>('/swarms/capacity?probe=true');
          emit(cap, formatCapacity(cap));
          return 0;
        }
        const view = await call<any>(`/swarms/${encodeURIComponent(sid)}`);
        emit(view, formatSwarmStatus(view));
        return 0;
      }
      case 'board': {
        const sid = parsed.positional[0] || '';
        if (!sid) {
          err('Usage: awsh swarm board <swarm_id> [--since N] [--limit N] [--json]');
          return 2;
        }
        const qs = new URLSearchParams();
        const sinceRaw = strFlag(parsed.flags, 'since');
        const limitRaw = strFlag(parsed.flags, 'limit');
        if (sinceRaw) qs.set('since', String(Math.max(0, Math.floor(parseNumFlag(sinceRaw, 'since')))));
        if (limitRaw) qs.set('limit', String(Math.max(1, Math.floor(parseNumFlag(limitRaw, 'limit')))));
        const path = qs.toString()
          ? `/swarms/${encodeURIComponent(sid)}/board?${qs.toString()}`
          : `/swarms/${encodeURIComponent(sid)}/board`;
        const board = await call<any>(path);
        emit(board, formatSwarmBoard(board));
        return 0;
      }
      case 'launch': {
        const goal = parsed.positional.join(' ').trim();
        if (!goal) {
          err('awsh swarm launch requires a <goal>.');
          return 2;
        }
        const leadsRaw = strFlag(parsed.flags, 'leads');
        const leads = leadsRaw ? splitMentions(leadsRaw) : undefined;
        const ownsRaw = strFlag(parsed.flags, 'owns');
        const mntRaw = strFlag(parsed.flags, 'must-not-touch');
        const owns = ownsRaw ? splitCsv(ownsRaw) : [];
        const mustNotTouch = mntRaw ? splitCsv(mntRaw) : [];

        const effortRaw = Number(strFlag(parsed.flags, 'effort') || 7);
        const effort = Number.isFinite(effortRaw) ? Math.max(6, Math.min(10, Math.round(effortRaw))) : 7;
        const coordinator = strFlag(parsed.flags, 'coordinator') || 'aither';
        const mode = strFlag(parsed.flags, 'mode');
        const modeLower = mode.trim().toLowerCase();
        const localFlag = boolFlag(parsed.flags, 'local');
        const cloudFlag = boolFlag(parsed.flags, 'cloud');
        const modeIsLocal = modeLower === 'local';
        const modeIsCloud = modeLower === 'cloud';
        if ((localFlag === true || modeIsLocal) && (cloudFlag === true || modeIsCloud)) {
          throw new CliInputError('Mutually exclusive flags: --local/--mode local cannot be combined with --cloud/--mode cloud.');
        }
        if (localFlag === false && modeIsLocal) {
          throw new CliInputError('Mutually exclusive flags: --local=false cannot be combined with --mode local.');
        }
        if (localFlag === false && cloudFlag === false) {
          throw new CliInputError('Mutually exclusive flags: --local=false cannot be combined with --cloud=false.');
        }
        if (modeIsCloud && cloudFlag === false) {
          throw new CliInputError('Mutually exclusive flags: --mode cloud cannot be combined with --cloud=false.');
        }
        const isLocal = localFlag === true || modeIsLocal;
        const localOnly = isLocal ? true : (localFlag === false || modeIsCloud ? false : cloudFlag !== true);

        const body: Record<string, unknown> = {
          goal,
          coordinator,
          effort,
          local_only: localOnly,
          work_elevated: true,
        };
        if (isLocal) {
          body.local_room = true;
          body.mode = 'local';
        } else if (modeIsCloud) {
          body.local_room = false;
          body.mode = 'cloud';
        } else if (mode) {
          body.mode = mode;
        }
        const roomId = strFlag(parsed.flags, 'room-id');
        if (roomId) body.room_id = roomId;

        const title = strFlag(parsed.flags, 'title');
        if (title) body.title = title;

        const worktree = boolFlag(parsed.flags, 'worktree', 'use-worktree');
        if (worktree !== undefined) body.use_worktree = worktree;
        const leases = boolFlag(parsed.flags, 'leases', 'use-leases');
        if (leases !== undefined) body.use_leases = leases;

        const workersRaw = strFlag(parsed.flags, 'workers');
        const poolsRaw = strFlag(parsed.flags, 'pools');
        if (workersRaw) {
          const workers = parseWorkersFlag(workersRaw).map((w: any) => {
            if (typeof w === 'object' && w !== null && !Array.isArray(w)) {
              const out = { ...w };
              if (owns.length && !out.owns) out.owns = owns;
              if (mustNotTouch.length && !out.must_not_touch) out.must_not_touch = mustNotTouch;
              return out;
            }
            return w;
          });
          body.workers = workers;
        }
        if (poolsRaw) {
          body.pools = parsePoolsFlag(poolsRaw, owns, mustNotTouch);
        }
        if (leads && leads.length) {
          if (!workersRaw && !poolsRaw && (owns.length || mustNotTouch.length)) {
            body.workers = leads.map((lead, idx) => ({
              slot_id: lead,
              agent: lead,
              ...(owns.length ? { owns: leads.length === owns.length ? [owns[idx]] : owns } : {}),
              ...(mustNotTouch.length ? { must_not_touch: mustNotTouch } : {}),
            }));
          } else {
            body.leads = leads;
          }
        } else if (!workersRaw && !poolsRaw && (owns.length || mustNotTouch.length)) {
          body.workers = [{
            slot_id: coordinator,
            agent: coordinator,
            ...(owns.length ? { owns } : {}),
            ...(mustNotTouch.length ? { must_not_touch: mustNotTouch } : {}),
          }];
        }

        applyF16Flags(parsed.flags, body);

        const created = await call<any>('/swarms', { method: 'POST', body: JSON.stringify(body) });
        emit(created, `Swarm ${created?.swarm_id || '?'} launched.\n${formatSwarmStatus(created)}`);
        return 0;
      }
      case 'post': {
        const [sid, ...rest] = parsed.positional;
        const text = rest.join(' ').trim();
        if (!sid || !text) {
          err('Usage: awsh swarm post <swarm_id> <text…> [--agent A] [--slot S] [--kind K] [--mentions a,b]');
          return 2;
        }
        const body: Record<string, unknown> = {
          agent: strFlag(parsed.flags, 'agent') || 'coordinator',
          text,
          kind: strFlag(parsed.flags, 'kind') || 'update',
        };
        const slot = strFlag(parsed.flags, 'slot-id') || strFlag(parsed.flags, 'slot');
        if (slot) body.slot_id = slot;
        const mentionsRaw = strFlag(parsed.flags, 'mentions');
        if (mentionsRaw) body.mentions = splitMentions(mentionsRaw);
        const thread = strFlag(parsed.flags, 'thread');
        if (thread) body.thread_id = thread;
        const artDir = strFlag(parsed.flags, 'artifact-dir');
        if (artDir) body.artifact_dir = artDir;
        const sealArtifacts = boolFlag(parsed.flags, 'seal-artifacts');
        if (sealArtifacts !== undefined) body.seal_artifacts = sealArtifacts;
        const expectKey = strFlag(parsed.flags, 'awseal-expect-key');
        if (expectKey) {
          body.expect_key = expectKey;
          body.awseal_expect_key = expectKey;
        }
        const keyPath = strFlag(parsed.flags, 'key-path');
        if (keyPath) body.key_path = keyPath;
        const localOnly = boolFlag(parsed.flags, 'local');
        if (localOnly !== undefined) body.local_only = localOnly;
        const noKeepWarm = boolFlag(parsed.flags, 'no-keep-warm');
        if (noKeepWarm !== undefined) body.keep_warm = !noKeepWarm;

        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/post`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const sealTag = res?.seal
          ? ` [seal:${res.seal.scheme || (res.seal.verified ? 'verified' : 'sha256')}]`
          : '';
        emit(res, `Posted to swarm ${sid}${res?.seq != null ? ` (board #${res.seq})` : ''}${sealTag}: ${text}`);
        return 0;
      }
      case 'steer': {
        const [sid, ...rest] = parsed.positional;
        const message = rest.join(' ').trim();
        if (!sid || !message) {
          err('Usage: awsh swarm steer <swarm_id> <message…> [--mentions a,b]');
          return 2;
        }
        const body: Record<string, unknown> = { message };
        const mentionsRaw = strFlag(parsed.flags, 'mentions');
        if (mentionsRaw) body.mentions = splitMentions(mentionsRaw);
        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/steer`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        emit(res, `Steered swarm ${sid}${res?.seq != null ? ` (board #${res.seq})` : ''}: ${message}`);
        return 0;
      }
      case 'nudge': {
        const sid = parsed.positional[0] || '';
        const explicitSlot = strFlag(parsed.flags, 'slot-id') || strFlag(parsed.flags, 'slot');
        const threadId = strFlag(parsed.flags, 'thread');
        const slotId = explicitSlot || (parsed.positional[1] || '');
        const reasonWords = explicitSlot ? parsed.positional.slice(1) : parsed.positional.slice(2);
        const reason = reasonWords.join(' ').trim() || strFlag(parsed.flags, 'reason');
        if (!sid || (!slotId && !threadId)) {
          err('Usage: awsh swarm nudge <swarm_id> <slot_id> [<reason…>] [--escalate-after S] [--force-escalate]');
          return 2;
        }
        const body: Record<string, unknown> = {};
        if (slotId) body.slot_id = slotId;
        if (threadId) body.thread_id = threadId;
        if (reason) body.reason = reason;
        const escRaw = strFlag(parsed.flags, 'escalate-after');
        if (escRaw) body.escalate_after_s = parseNumFlag(escRaw, 'escalate-after');
        const forceEsc = boolFlag(parsed.flags, 'force-escalate');
        if (forceEsc !== undefined) body.force_escalate = forceEsc;

        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/nudge`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        emit(
          res,
          `Nudged swarm ${sid} (${res?.slot_id || slotId || threadId}) -> ${res?.action || 'nudged'}${res?.escalated ? ' [escalated]' : ''}`,
        );
        return 0;
      }
      case 'pause':
      case 'resume':
      case 'cancel': {
        const sid = parsed.positional[0] || '';
        if (!sid) {
          err(`Usage: awsh swarm ${parsed.action} <swarm_id> [--reason R]`);
          return 2;
        }
        const reason = strFlag(parsed.flags, 'reason');
        const body: Record<string, unknown> = { action: parsed.action, reason };
        const exportRuns = boolFlag(parsed.flags, 'export-runs');
        if (exportRuns !== undefined) body.export_runs = exportRuns;
        const exportDir = strFlag(parsed.flags, 'export-dir');
        if (exportDir) body.export_dir = exportDir;

        const path = parsed.action === 'pause'
          ? `/swarms/${encodeURIComponent(sid)}/pause`
          : `/swarms/${encodeURIComponent(sid)}/control`;
        const res = await call<any>(path, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        emit(res, `Swarm ${sid} -> ${res?.status || parsed.action}`);
        return 0;
      }
      case 'delegate': {
        const [sid, ...rest] = parsed.positional;
        const prompt = rest.join(' ').trim();
        const harness = (strFlag(parsed.flags, 'harness') || 'claude').toLowerCase();
        if (!sid || !prompt) {
          err('Usage: awsh swarm delegate <swarm_id> --harness claude|codex|gemini|aither|awdk --agent <lead> <prompt…>');
          return 2;
        }
        const body: Record<string, unknown> = {
          harness,
          prompt,
          agent: strFlag(parsed.flags, 'agent') || 'demiurge',
          cwd: strFlag(parsed.flags, 'cwd') || deps.cwd || process.cwd(),
          wait: parsed.flags.wait === true,
        };
        const profile = strFlag(parsed.flags, 'model-profile');
        const thread = strFlag(parsed.flags, 'thread');
        const reportTo = strFlag(parsed.flags, 'report-to');
        const slot = strFlag(parsed.flags, 'slot-id') || strFlag(parsed.flags, 'slot');
        const memberId = strFlag(parsed.flags, 'member-id');
        const pool = strFlag(parsed.flags, 'pool');
        const ownsRaw = strFlag(parsed.flags, 'owns');
        const mntRaw = strFlag(parsed.flags, 'must-not-touch');
        const worktree = boolFlag(parsed.flags, 'worktree', 'use-worktree');
        const leases = boolFlag(parsed.flags, 'leases', 'use-leases');
        const noKeepWarm = boolFlag(parsed.flags, 'no-keep-warm');
        const localOnly = boolFlag(parsed.flags, 'local');
        const timeoutRaw = strFlag(parsed.flags, 'timeout');

        if (profile) body.model_profile = profile;
        if (thread) body.thread_id = thread;
        if (reportTo) body.report_to = reportTo;
        if (slot) body.slot_id = slot;
        if (memberId) body.member_id = memberId;
        if (pool) body.pool = pool;
        if (ownsRaw) body.owns = splitCsv(ownsRaw);
        if (mntRaw) body.must_not_touch = splitCsv(mntRaw);
        if (worktree !== undefined) body.use_worktree = worktree;
        if (leases !== undefined) body.use_leases = leases;
        if (noKeepWarm !== undefined) body.keep_warm = !noKeepWarm;
        if (localOnly !== undefined) {
          body.local_only = localOnly;
          if (localOnly) body.local_room = true;
        }
        if (timeoutRaw) body.timeout_s = parseNumFlag(timeoutRaw, 'timeout');

        applyF16Flags(parsed.flags, body);

        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/delegate-harness`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const extraBits: string[] = [];
        if (res?.slot_id) extraBits.push(`slot=${res.slot_id}`);
        if (res?.worktree_path) extraBits.push(`wt=${res.worktree_path}`);
        if (Array.isArray(res?.lease_ids) && res.lease_ids.length) extraBits.push(`leases=${res.lease_ids.join(',')}`);
        if (res?.execution_mode && res.execution_mode !== 'standard') extraBits.push(`exec=${res.execution_mode}`);
        if (res?.run_id) extraBits.push(`run=${res.run_id}`);
        if (res?.inference_runtime && res.inference_runtime !== 'standard') extraBits.push(`rt=${res.inference_runtime}`);
        if (res?.shared_ro_mmap) extraBits.push(res?.shared_ro_mode || 'D5_shared_ro');
        const extra = extraBits.length ? ` [${extraBits.join(' ')}]` : '';
        emit(
          res,
          `Delegated ${sid} worker (${res?.agent || body.agent}) to local ${harness} session ${res?.session_id || '?'}${extra} (UI: ${res?.ui_url || ''})`,
        );
        return 0;
      }
      default:
        err(swarmUsage());
        return 2;
    }
  } catch (e: any) {
    if (e instanceof CliInputError) {
      err(e.message);
      return 2;
    }
    err(`awsh swarm failed: ${e?.message || e}`);
    return 1;
  }
}
