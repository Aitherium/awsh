/**
 * `aither decisions …` — first-class decision-card surface for the CLI.
 *
 * The daemon (adk harness serve) owns the decision store at ~/.aither/decisions.
 * This is a THIN client of it, modeled after `aither harness` and `aither room`.
 * The daemon is reachable when Genesis is not (it is the local process supervisor),
 * so this must not depend on backend resolution.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as theme from './theme.js';

const DEFAULT_URL = 'http://127.0.0.1:8362';

function daemonUrl(): string {
  return (process.env.AITHER_HARNESS_URL || DEFAULT_URL).replace(/\/$/, '');
}

/**
 * Bearer resolution mirrors the daemon's own order: env, then the file it
 * writes at first start. Returning '' rather than throwing lets the caller
 * emit one clear "start the daemon" message instead of a stack trace.
 */
function daemonToken(): string {
  const fromEnv = (process.env.AITHER_HARNESS_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.aither', 'harness_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = daemonToken();
  if (!token) {
    throw new Error(
      'no harness token found (set AITHER_HARNESS_TOKEN or start the daemon: adk harness serve)',
    );
  }
  const res = await fetch(`${daemonUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { detail: text };
  }
  if (!res.ok) throw new Error(payload?.detail || payload?.error || `HTTP ${res.status}`);
  return payload as T;
}

interface Card {
  id: string;
  title: string;
  summary: string;
  detail: string;
  kind: 'decision' | 'blocked' | 'info' | 'critical';
  urgency: 'normal' | 'high' | 'critical';
  options: Array<{
    key: string;
    label: string;
    consequence: string;
    recommended?: boolean;
  }>;
  default_key?: string;
  facts: string[];
  notes: Array<{ text: string }>;
  created_at: number;
  deadline?: number | null;
  status: 'open' | 'answered' | 'cancelled' | 'expired';
  answer?: string;
  answer_note?: string;
  answered_at?: number;
  answered_via?: string;
  source?: {
    session_id?: string;
    agent?: string;
    cwd?: string;
    branch?: string;
    host?: string;
    pid?: number;
    session_pid?: number;
    transcript?: string;
  };
}

interface DecisionsResponse {
  decisions: Card[];
  count: number;
}

interface CountResponse {
  open: number;
  urgent: number;
  oldest_age_seconds?: number;
}

function formatAge(epochSeconds: number): string {
  const age = Math.floor((Date.now() / 1000) - epochSeconds);
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  return `${Math.floor(age / 86400)}d`;
}

function cwdBasename(cwd?: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function usage(): void {
  console.log(`aither decisions — pending decisions from concurrent Claude sessions

  aither decisions [list]                    open decisions
  aither decisions list [--all] [--session <id>]
  aither decisions show <id>                 full card details
  aither decisions answer <id> <choice> [--note "..."]
  aither decisions cancel <id> [--note "..."]
  aither decisions watch [--interval 5]      poll and print new cards
  aither decisions count                     compact status (for prompt segment)

The daemon is the local process supervisor (adk harness serve). It is reachable
when Genesis is not, so this command never depends on the fleet being up.`);
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function flagExists(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function listCards(
  args: string[],
): Promise<void> {
  const showAll = flagExists(args, 'all');
  const sessionFilter = flag(args, 'session', '');
  const status = showAll ? 'all' : 'open';
  let path = `/decisions?status=${status}`;
  if (sessionFilter) path += `&session_id=${encodeURIComponent(sessionFilter)}`;

  const res = await api<DecisionsResponse>(path);
  if (!res.decisions || res.decisions.length === 0) {
    const msg = showAll ? 'No decisions.' : 'No open decisions.';
    console.log(theme.muted(`  ${msg}`));
    return;
  }

  for (const card of res.decisions) {
    const age = formatAge(card.created_at);
    const id = theme.accent(card.id.substring(0, 8));
    const urg =
      card.urgency === 'critical'
        ? theme.bad('●')
        : card.urgency === 'high'
          ? theme.warn('◑')
          : theme.muted('○');
    const sessionPart = card.source?.session_id ? `@${card.source.session_id.substring(0, 6)}` : '';
    const cwdPart = card.source?.cwd ? `[${cwdBasename(card.source.cwd)}]` : '';
    const source = theme.muted(theme.metaJoin([sessionPart, cwdPart]));
    const title = card.title || '(untitled)';

    console.log(`  ${id}  ${urg}  ${age.padEnd(4)}  ${source.padEnd(24)}  ${title}`);
  }
}

async function showCard(id: string): Promise<void> {
  const res = await api<Card>(`/decisions/${id}`);

  // Title
  console.log();
  console.log(theme.accent(`  ${res.title || '(untitled)'}`));

  // Summary
  if (res.summary) {
    console.log(theme.muted(`  ${res.summary}`));
  }

  // Divider
  console.log(theme.ruleColor('  ' + '─'.repeat(70)));

  // Detail — never truncate (DC001 gate)
  if (res.detail) {
    console.log();
    const lines = res.detail.split('\n');
    for (const line of lines) {
      console.log(`  ${line}`);
    }
  }

  // Facts — never truncate
  if (res.facts && res.facts.length > 0) {
    console.log();
    console.log(theme.muted('  Facts:'));
    for (const fact of res.facts) {
      console.log(`    • ${fact}`);
    }
  }

  // Options
  if (res.options && res.options.length > 0) {
    console.log();
    console.log(theme.muted('  Options:'));
    for (const opt of res.options) {
      const rec = opt.recommended ? ' ' + theme.ok('[recommended]') : '';
      console.log(`    ${theme.accent(opt.key)}) ${opt.label} — ${opt.consequence}${rec}`);
    }
    if (res.default_key) {
      console.log(theme.muted(`    default: ${res.default_key}`));
    }
  }

  // Status
  console.log();
  const statusText =
    res.status === 'answered'
      ? `answered: ${res.answer} ${res.answer_note ? `(${res.answer_note})` : ''}`
      : res.status === 'cancelled'
        ? `cancelled ${res.answer_note ? `(${res.answer_note})` : ''}`
        : res.status === 'expired'
          ? 'expired'
          : 'open';
  console.log(theme.muted(`  Status: ${statusText}`));

  // Source
  if (res.source) {
    const parts = [
      res.source.session_id ? `session ${res.source.session_id}` : null,
      res.source.cwd ? `in ${res.source.cwd}` : null,
      res.source.branch ? `@ ${res.source.branch}` : null,
    ];
    const sourceStr = parts.filter(Boolean).join(', ');
    if (sourceStr) {
      console.log(theme.muted(`  From: ${sourceStr}`));
    }
  }
  console.log();
}

async function answerCard(
  args: string[],
): Promise<void> {
  const id = args[0];
  const choice = args[1];
  const note = flag(args, 'note', '');

  if (!id || !choice) {
    console.error('usage: aither decisions answer <id> <choice> [--note "..."]');
    throw new Error('missing arguments');
  }

  await api(`/decisions/${id}/answer`, {
    method: 'POST',
    body: JSON.stringify({ choice, note }),
  });
  console.log(theme.ok(`  ✓ answered ${id.substring(0, 8)} = ${choice}`));
}

async function cancelCard(
  args: string[],
): Promise<void> {
  const id = args[0];
  const note = flag(args, 'note', '');

  if (!id) {
    console.error('usage: aither decisions cancel <id> [--note "..."]');
    throw new Error('missing arguments');
  }

  await api(`/decisions/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  console.log(theme.ok(`  ✓ cancelled ${id.substring(0, 8)}`));
}

async function watchCards(args: string[]): Promise<void> {
  const interval = Number(flag(args, 'interval', '5')) || 5;
  const intervalMs = interval * 1000;
  let lastSeen = new Set<string>();

  console.log(theme.muted(`  watching for new decisions (every ${interval}s)...`));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await api<DecisionsResponse>('/decisions?status=open');
      const current = new Set(res.decisions.map((c) => c.id));

      // Find new cards
      for (const card of res.decisions) {
        if (!lastSeen.has(card.id)) {
          const urg =
            card.urgency === 'critical'
              ? theme.bad('●')
              : card.urgency === 'high'
                ? theme.warn('◑')
                : theme.muted('○');
          const sessionPart = card.source?.session_id
            ? `@${card.source.session_id.substring(0, 6)}`
            : '';
          const source = theme.muted(sessionPart);
          console.log(
            theme.accent(`  ✦ ${card.id.substring(0, 8)}`)
            + ` ${urg} ${source} ${card.title || '(untitled)'}`,
          );
        }
      }

      lastSeen = current;
    } catch (err) {
      // Connection error; continue trying
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function countCards(
  _args: string[],
): Promise<void> {
  const res = await api<CountResponse>('/decisions/count');
  if (res.open === 0) {
    // Print nothing when zero — a status line that always says "0 decisions" is noise
    return;
  }
  const parts: string[] = [];
  parts.push(`${res.open} open`);
  if (res.urgent > 0) {
    parts.push(`${res.urgent} urgent`);
  }
  console.log(theme.accent(parts.join(', ')));
}

/** Returns a process exit code. Never throws — the caller is a CLI entrypoint. */
export async function runDecisionsCommand(args: string[]): Promise<number> {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    return 0;
  }
  try {
    switch (sub) {
      case 'list': {
        await listCards(args.slice(1));
        return 0;
      }
      case 'show': {
        if (!args[1]) {
          console.error('usage: aither decisions show <id>');
          return 2;
        }
        await showCard(args[1]);
        return 0;
      }
      case 'answer': {
        await answerCard(args.slice(1));
        return 0;
      }
      case 'cancel': {
        await cancelCard(args.slice(1));
        return 0;
      }
      case 'watch': {
        await watchCards(args.slice(1));
        return 0;
      }
      case 'count': {
        await countCards(args.slice(1));
        return 0;
      }
      // Default to list if no subcommand or unrecognized
      default:
        await listCards(args);
        return 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(theme.bad(`decisions: ${msg}`));
    // Name the fix rather than only the symptom — "fetch failed" on its own
    // sends people to their network settings.
    if (/fetch failed|ECONNREFUSED|no harness token/i.test(msg)) {
      console.error(
        theme.muted(`  daemon expected at ${daemonUrl()} — start it with:  adk harness serve`),
      );
    }
    return 1;
  }
}
