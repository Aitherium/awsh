/**
 * `awsh swarm <list|status|launch|steer|pause|resume|cancel|delegate|capacity>`
 *
 * Drives Genesis's live SwarmBoardEngine via the local awsh harness daemon (:8362
 * `/swarms/*`), with fail-closed auth (`AITHER_HARNESS_TOKEN` / `~/.aither/harness_token`,
 * never printing secrets). Also lets the owner delegate a SwarmBoard worker slot
 * directly to a local coding harness (`claude`, `codex`, `gemini`, `aither`, `awdk`).
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
  | 'capacity'
  | 'help';

export const SWARM_ACTIONS: readonly SwarmAction[] = [
  'list', 'status', 'launch', 'steer', 'pause', 'resume', 'cancel', 'delegate', 'capacity', 'help',
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
  'status', 'limit', 'leads', 'coordinator', 'title', 'effort',
  'reason', 'harness', 'agent', 'cwd', 'model-profile', 'thread', 'report-to', 'timeout',
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
        if (VALUE_FLAGS.has(k) && i + 1 < args.length) {
          flags[k] = args[++i];
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
    '  awsh swarm list [--status live|stalled|paused|done] [--limit N] [--json]',
    '  awsh swarm status [swarm_id] [--json]      inspect a swarm (or local Swarm capacity)',
    '  awsh swarm launch <goal…> [--leads atlas,demi,vera] [--coordinator aither]',
    '                            [--title T] [--effort 7] [--json]',
    '  awsh swarm steer <swarm_id> <message…>     post a human steering directive',
    '  awsh swarm pause <swarm_id> [--reason R]   pause an active swarm',
    '  awsh swarm resume <swarm_id>               resume a paused swarm',
    '  awsh swarm cancel <swarm_id> [--reason R]  cancel a swarm',
    '  awsh swarm delegate <swarm_id> --harness claude|codex|gemini|aither|awdk',
    '                      --agent <lead> <prompt…> [--cwd .] [--wait]',
    '  awsh swarm capacity [--no-probe] [--json]  show local harness & live Genesis reachability',
    '',
    '  Env: AITHER_SWARM_API_URL overrides the SwarmBoard API base URL (defaults to',
    '       AITHER_GENESIS_URL or the control-plane Genesis bridge, never localhost:8001).',
  ].join('\n');
}

function strFlag(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  return typeof v === 'string' ? v.trim() : '';
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
      const title = String(r?.title || r?.goal?.title || 'Untitled').slice(0, 64);
      const prog = r?.overview?.progress;
      const done = prog ? `${prog.done ?? 0}/${prog.total ?? 0}` : '';
      const ui = r?.ui_url ? `  ${r.ui_url}` : '';
      lines.push(`  ${sid}  [${st.trim()}]${done ? ` (${done})` : ''}  ${title}${ui}`);
    }
  }
  const cap = data?.capacity;
  if (cap) {
    const hs = Array.isArray(cap.swarm_harnesses) && cap.swarm_harnesses.length
      ? cap.swarm_harnesses.join(', ')
      : 'none detected';
    lines.push(`Local harnesses (${cap.node || 'host'}): ${hs} | UI: ${cap.ui_url || data?.ui_url || 'https://app.aitherium.com/swarm'}`);
  }
  return lines.join('\n');
}

export function formatSwarmStatus(view: any): string {
  const sid = String(view?.swarm_id || '?');
  const title = String(view?.title || view?.goal?.title || 'Untitled');
  const status = String(view?.status || 'unknown');
  const prog = view?.overview?.progress;
  const done = prog ? `${prog.done ?? 0}/${prog.total ?? 0}` : '?';
  const members: string[] = (Array.isArray(view?.members) ? view.members : [])
    .map((m: any) => `${m?.name || '?'}(${m?.state || '?'})`);
  const lines = [
    `Swarm ${sid} — ${title}`,
    `  Status:   ${status}  |  Progress: ${done}`,
  ];
  if (members.length) lines.push(`  Team:     ${members.join(', ')}`);
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

export async function runSwarmCommand(argv: string[], deps: SwarmCommandDeps = {}): Promise<number> {
  const log = deps.log || ((line: string) => console.log(line));
  const err = deps.err || ((line: string) => console.error(line));
  const parsed = parseSwarmArgs(argv);
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
        if (st) qs.set('status', st);
        if (lim) qs.set('limit', lim);
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
      case 'launch': {
        const goal = parsed.positional.join(' ').trim();
        if (!goal) {
          err('awsh swarm launch requires a <goal>.');
          return 2;
        }
        const leadsRaw = strFlag(parsed.flags, 'leads');
        const leads = leadsRaw ? leadsRaw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) : undefined;
        const effortRaw = Number(strFlag(parsed.flags, 'effort') || 7);
        const effort = Number.isFinite(effortRaw) ? Math.max(6, Math.min(10, Math.round(effortRaw))) : 7;
        const body: Record<string, unknown> = {
          goal,
          coordinator: strFlag(parsed.flags, 'coordinator') || 'aither',
          effort,
          local_only: parsed.flags.cloud !== true,
          work_elevated: true,
        };
        const title = strFlag(parsed.flags, 'title');
        if (title) body.title = title;
        if (leads && leads.length) body.leads = leads;
        const created = await call<any>('/swarms', { method: 'POST', body: JSON.stringify(body) });
        emit(created, `Swarm ${created?.swarm_id || '?'} launched.\n${formatSwarmStatus(created)}`);
        return 0;
      }
      case 'steer': {
        const [sid, ...rest] = parsed.positional;
        const message = rest.join(' ').trim();
        if (!sid || !message) {
          err('Usage: awsh swarm steer <swarm_id> <message…>');
          return 2;
        }
        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/steer`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        });
        emit(res, `Steered swarm ${sid}${res?.seq != null ? ` (board #${res.seq})` : ''}: ${message}`);
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
        const path = parsed.action === 'pause'
          ? `/swarms/${encodeURIComponent(sid)}/pause`
          : `/swarms/${encodeURIComponent(sid)}/control`;
        const res = await call<any>(path, {
          method: 'POST',
          body: JSON.stringify({ action: parsed.action, reason }),
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
        if (profile) body.model_profile = profile;
        if (thread) body.thread_id = thread;
        if (reportTo) body.report_to = reportTo;
        const res = await call<any>(`/swarms/${encodeURIComponent(sid)}/delegate-harness`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        emit(
          res,
          `Delegated ${sid} worker (${res?.agent || body.agent}) to local ${harness} session ${res?.session_id || '?'} (UI: ${res?.ui_url || ''})`,
        );
        return 0;
      }
      default:
        err(swarmUsage());
        return 2;
    }
  } catch (e: any) {
    err(`awsh swarm failed: ${e?.message || e}`);
    return 1;
  }
}
