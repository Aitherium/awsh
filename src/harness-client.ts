/**
 * `aither harness …` — drive the AitherShell harness daemon from the shell.
 *
 * The daemon (adk harness serve) owns every session: Claude Code, Gemini CLI,
 * a real pty, a Linux TTY in a dev-workspace container, sovereign agents and
 * multi-agent group chat. This is a THIN client of it, exactly like
 * `adk harness` — which is the point: a session started here is the same
 * session the browser attaches to on aitherium.com, because neither of them
 * owns it.
 *
 * Deliberately a standalone module with no GenesisClient dependency: the
 * harness daemon is reachable when Genesis is not (it is the local process
 * supervisor), and coupling the two would make the shell useless offline.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:8362';

// daemonUrl/daemonToken/api are exported so sibling daemon-client modules
// (awrun-client.ts and any future one) reuse the SAME auth resolution and
// error-shaping instead of a second copy that can drift — same lesson as
// the shared browser-inference worker in this repo, where a comment asking
// people to "keep them in step" did not stop the drift; only one copy does.

export function daemonUrl(): string {
  return (process.env.AITHER_HARNESS_URL || DEFAULT_URL).replace(/\/$/, '');
}

/**
 * Bearer resolution mirrors the daemon's own order: env, then the file it
 * writes at first start. Returning '' rather than throwing lets the caller
 * emit one clear "start the daemon" message instead of a stack trace.
 */
export function daemonToken(): string {
  const fromEnv = (process.env.AITHER_HARNESS_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.aither', 'harness_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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

function usage(): void {
  console.log(`aither harness — one shell that drives every coding shell

  aither harness list                       live sessions
  aither harness harnesses                  what this box can drive
  aither harness agents                     sovereign agent roster
  aither harness new [--harness claude|claude-tty|terminal…] [--model-profile deepseek-flash]
                     [--cwd .] [--title T] [--agent atlas] [--target <container>]
                     [--extra-args "--flag,--flag2"]   (claude-tty/terminal argv)
  aither harness send <id> <text…>
  aither harness attach <id>                follow the event stream
  aither harness attach --pty <id>          put THIS terminal on a pty session (Ctrl+] detaches)
  aither harness tell <target> <text…>      say it to ONE session: a session id, a Claude id,
                                            a unique prefix of either, or a unique title word.
                                            Lands now in a tab awsh opened; at the end of the
                                            current turn in any other tab.
  aither harness kill <id>

Sessions live in the daemon (adk harness serve), so one started here is the
same session the browser attaches to on aitherium.com.`);
}

export interface TellRow {
  id: string; title?: string; origin?: string; status?: string;
  harness_session_id?: string; extras?: Record<string, any>;
}

/**
 * Exactly-one resolution for `tell`. A target matches a row by id, by the Claude session id
 * the program carries (extras.harness_session_id), by a PREFIX of either, or by a
 * case-insensitive word in the title. Zero or many is a refusal, never a guess: measured
 * 2026-09-19 three tabs on stage were all titled "AitherOS-Fresh", which is exactly the
 * ambiguity that would put the owner's words in front of the wrong session.
 */
export function resolveTellTarget(rows: TellRow[], needle: string): TellRow[] {
  const n = (needle || '').trim().toLowerCase();
  if (!n) return [];
  // A session that has exited cannot be told anything; resolving it would queue the
  // owner's words for a process that will never read them.
  rows = rows.filter((r) => r.status !== 'exited');
  const ids = (r: TellRow) => [r.id, String(r.harness_session_id || r.extras?.harness_session_id || '')]
    .filter(Boolean).map((x) => x.toLowerCase());
  const exact = rows.filter((r) => ids(r).includes(n));
  if (exact.length) return exact;
  const byPrefix = rows.filter((r) => ids(r).some((x) => x.startsWith(n)));
  if (byPrefix.length) return byPrefix;
  return rows.filter((r) => (r.title || '').toLowerCase().includes(n));
}

/** The steering event a human sends from awsh -- the desk's steerEvent envelope, same keys. */
export function tellEvent(targetId: string, text: string, room = 'main'): Record<string, unknown> {
  return {
    room,
    type: 'steering',
    to: [targetId],
    hops: 0,
    actor: { kind: 'human', id: 'owner', name: 'the owner (awsh)' },
    payload: { text, source: 'awsh:tell' },
  };
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function render(ev: any): void {
  const who = ev?.data?.participant ? `[${ev.data.participant}] ` : '';
  switch (ev.kind) {
    case 'text.delta':
      process.stdout.write(who + ev.text);
      break;
    case 'thinking.delta':
      process.stdout.write(`\x1b[2m${ev.text}\x1b[0m`);
      break;
    case 'tool.call':
      console.log(`\n\x1b[36m→ ${ev.tool}\x1b[0m`);
      break;
    case 'tool.result':
      console.log(`\x1b[36m← ${ev.tool || 'result'}${ev.data?.is_error ? ' (error)' : ''}\x1b[0m`);
      break;
    case 'error':
      console.error(`\n\x1b[31m! ${ev.text}\x1b[0m`);
      break;
    case 'turn.completed':
      console.log('');
      break;
    case 'session.exited':
      console.log(`\n\x1b[2m-- session exited (${ev.data?.exit_code}) --\x1b[0m`);
      break;
    default:
      break;
  }
}

async function attach(id: string, since = 0): Promise<number> {
  let cursor = since;
  for (;;) {
    const res = await api<{ events: any[]; state: string }>(
      `/sessions/${id}/events?since=${cursor}`,
    );
    for (const ev of res.events) {
      cursor = ev.seq;
      render(ev);
      if (ev.kind === 'session.exited') return 0;
      if (ev.kind === 'turn.completed') return 0;
    }
    if (res.state === 'exited' || res.state === 'failed') return 0;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Returns a process exit code. Never throws — the caller is a CLI entrypoint. */
export async function runHarnessCommand(args: string[]): Promise<number> {
  const sub = (args[0] || '').toLowerCase();
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    return 0;
  }
  try {
    switch (sub) {
      case 'harnesses': {
        const r = await api<{ harnesses: any[] }>('/harnesses');
        for (const h of r.harnesses) {
          const mark = h.installed ? ' ' : '!';
          console.log(`${mark} ${h.id.padEnd(11)} ${h.transport.padEnd(17)} ${h.description}`);
          if (!h.installed && h.install_hint) {
            console.log(`${' '.repeat(14)}-> ${h.install_hint}`);
          }
        }
        return 0;
      }
      case 'agents': {
        const r = await api<{ agents: any[] }>('/agents');
        for (const a of r.agents) console.log(`${a.id.padEnd(12)} ${a.label.padEnd(14)} ${a.role}`);
        return 0;
      }
      case 'list': {
        const r = await api<{ sessions: any[] }>('/sessions');
        if (!r.sessions.length) {
          console.log('No sessions. Start one:  aither harness new --harness claude');
          return 0;
        }
        for (const s of r.sessions) {
          console.log(
            `${s.id.padEnd(18)} ${s.harness.padEnd(10)} ${s.state.padEnd(9)} ${s.title || ''}`,
          );
        }
        return 0;
      }
      case 'new': {
        const body: Record<string, unknown> = {
          harness: flag(args, 'harness', 'claude'),
          cwd: flag(args, 'cwd', process.cwd()),
          title: flag(args, 'title'),
          agent: flag(args, 'agent'),
          target: flag(args, 'target'),
        };
        const profile = flag(args, 'model-profile');
        if (profile) body.model_profile = profile;
        const extra = flag(args, 'extra-args');
        if (extra) body.extra_args = extra.split(',').map((a) => a.trim()).filter(Boolean);
        const created = await api<{ id: string }>('/sessions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        console.log(created.id);
        return 0;
      }
      case 'send': {
        const id = args[1];
        const text = args.slice(2).join(' ');
        if (!id || !text) {
          console.error('usage: aither harness send <id> <text…>');
          return 2;
        }
        await api(`/sessions/${id}/input`, { method: 'POST', body: JSON.stringify({ text }) });
        return attach(id);
      }
      case 'attach': {
        const pty = args.includes('--pty');
        const id = args.slice(1).find((a) => !a.startsWith('--') && a !== flag(args, 'since'));
        if (!id) {
          console.error('usage: aither harness attach [--pty] <id>');
          return 2;
        }
        if (pty) {
          const { attachPty } = await import('./pty-attach.js');
          return attachPty(id, { since: Number(flag(args, 'since', '0')) || 0 });
        }
        return attach(id, Number(flag(args, 'since', '0')) || 0);
      }
      case 'tell': {
        const target = args[1];
        const text = args.slice(2).join(' ').trim();
        if (!target || !text) {
          console.error('usage: aither harness tell <target> <text…>');
          return 2;
        }
        const listing = await api<{ sessions: TellRow[] }>('/sessions/unified');
        const matches = resolveTellTarget(listing.sessions || [], target);
        if (matches.length !== 1) {
          console.error(matches.length
            ? `'${target}' matches ${matches.length} sessions — be more specific:`
            : `no session matches '${target}'. Sessions:`);
          for (const r of (matches.length ? matches : listing.sessions || []).slice(0, 12)) {
            console.error(`  ${r.id.slice(0, 13).padEnd(14)} ${(r.origin || '').padEnd(11)} ${r.title || ''}`);
          }
          return 1;
        }
        const row = matches[0];
        const published = await api<{ seq: number }>('/events', {
          method: 'POST',
          body: JSON.stringify(tellEvent(row.id, text)),
        });
        // The receipt is the truth about delivery; wait briefly for it rather than assume.
        const deadline = Date.now() + 8000;
        let receipt: any = null;
        while (!receipt && Date.now() < deadline) {
          const ev = await api<{ events: any[] }>('/rooms/main/events?limit=40');
          receipt = (ev.events || []).find((e) => e.type === 'steering_receipt'
            && e.payload?.target === row.id && (e.seq || 0) > (published.seq || 0));
          if (!receipt) await new Promise((r) => setTimeout(r, 400));
        }
        const p = receipt?.payload;
        console.log(p
          ? `told ${row.title || row.id.slice(0, 12)} — ${p.channel}${p.landed_now ? ' (landed now)' : ''}: ${p.detail}`
          : `published to ${row.title || row.id.slice(0, 12)}; no receipt yet (the room may be busy)`);
        return p && p.channel === 'none' ? 1 : 0;
      }
      case 'kill': {
        if (!args[1]) {
          console.error('usage: aither harness kill <id>');
          return 2;
        }
        const r = await api<{ exit_code: number | null }>(`/sessions/${args[1]}`, {
          method: 'DELETE',
        });
        console.log(`stopped ${args[1]} (exit ${r.exit_code})`);
        return 0;
      }
      default:
        console.error(`unknown subcommand: ${sub}`);
        usage();
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`harness: ${msg}`);
    // Name the fix rather than only the symptom — "fetch failed" on its own
    // sends people to their network settings.
    if (/fetch failed|ECONNREFUSED|no harness token/i.test(msg)) {
      console.error(`  daemon expected at ${daemonUrl()} — start it with:  adk harness serve`);
    }
    return 1;
  }
}
