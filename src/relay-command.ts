/**
 * `/relay read|send|channels` and `/dm` -- relay chat that runs ONCE and returns: one-shot
 * `awsh relay ...` / `awsh dm ...` for scripts and agents, and the same verbs from inside
 * either shell. Live chat is unchanged: `/relay [#channel]` in the TUI or the readline REPL
 * still joins and streams over the socket (relay.ts).
 *
 *   relay channels [scope]        the channels you can see (platform | community | workspace:<slug>)
 *   relay read <channel> [n]      the newest n messages, oldest first (default 20)
 *   relay send <channel> <text>   post one line as you
 *   relay dm ...                  the same as /dm
 *
 * The '#' is optional: an unquoted `#ops` on a bash or PowerShell command line is a
 * comment, so `awsh relay read ops` is the spelling that survives a shell.
 *   dm                            your DM conversations, with the last line of each
 *   dm <nick>                     the conversation with nick
 *   dm <nick> <text>              DM nick
 *
 * Before 2026-10-28 the shell could join a channel and type into it, and nothing else: no
 * DMs at all, and `awsh relay ...` fell through to a chat turn. The relay derives WHO you
 * are from your sign-in token, so sending and DMs need `awsh login`; reading a channel is
 * open, as it is on the web. A refusal is the relay's own words -- nothing is retried under
 * another nick.
 */

import chalk from 'chalk';
import type { RelayChannel, RelayDm, RelayDmPartner, RelayMessage, RelayResult } from './relay.js';

/** The `/relay` verbs that run once instead of joining live chat. */
export const RELAY_ONESHOT_VERBS: ReadonlySet<string> = new Set(['read', 'send', 'dm', 'dms', 'channels']);

/** True when `/relay <args>` names a verb that runs once (`channels` only outside live chat). */
export function isRelayOneShot(args: string, inLiveChat = false): boolean {
  const verb = (args.trim().split(/\s+/)[0] || '').toLowerCase();
  if (inLiveChat && verb === 'channels') return false;   // live chat lists its own
  return RELAY_ONESHOT_VERBS.has(verb);
}

/** The slice of RelayClient these verbs use (structural, so tests pass a plain fake). */
export interface RelayRest {
  channels(scope?: string): Promise<RelayResult<RelayChannel[]>>;
  read(channel: string, limit?: number): Promise<RelayResult<RelayMessage[]>>;
  post(channel: string, content: string): Promise<RelayResult<RelayMessage | null>>;
  dmPartners(): Promise<RelayResult<RelayDmPartner[]>>;
  dmHistory(nick: string, limit?: number): Promise<RelayResult<RelayDm[]>>;
  sendDm(toNick: string, content: string): Promise<RelayResult<{ delivered: boolean; message: RelayDm | null }>>;
}

export interface RelayCommandDeps {
  relay: RelayRest;
  /** A sign-in token is present (the relay checks it; this only spares a doomed call). */
  signedIn: boolean;
  out: (line: string) => void;
}

/** What a verb did: ok, or the one line that says why not (the caller raises it). */
export type RelayOutcome = { ok: true } | { ok: false; error: string };

export const RELAY_USAGE = 'usage: /relay channels [scope] | read <channel> [n] | send <channel> <text> | dm [<nick> [text]]  (# optional)';
export const DM_USAGE = 'usage: /dm  |  /dm <nick>  |  /dm <nick> <text>';
const SIGN_IN = 'sign in first: awsh login (the relay knows you by your token)';

const clock = (ts: unknown): string => {
  const d = new Date(String(ts ?? ''));
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};

/** One channel line (pure): time, nick (agents as @nick), content. */
export function formatChannelLine(m: RelayMessage): string {
  const who = m.agent ? chalk.magenta('@' + m.nick) : chalk.cyan(m.nick);
  const t = clock(m.timestamp);
  return `  ${t ? chalk.dim(t) + ' ' : ''}${who}: ${m.content}`;
}

/** One DM line (pure). */
export function formatDmLine(m: RelayDm): string {
  const who = m.agent ? chalk.magenta('@' + m.from_nick) : chalk.cyan(m.from_nick);
  const t = clock(m.timestamp);
  return `  ${t ? chalk.dim(t) + ' ' : ''}${who}: ${m.content}`;
}

/** One conversation row (pure): online dot, nick, the last line cut to fit. */
export function formatPartnerLine(p: RelayDmPartner): string {
  const dot = p.online ? chalk.green('●') : chalk.dim('○');
  const last = p.last_message ? `${p.last_message.from_nick}: ${p.last_message.content}` : '';
  const cut = last.length > 70 ? last.slice(0, 69) + '…' : last;
  return `  ${dot} ${chalk.bold(p.nick)}${cut ? chalk.dim('  ' + cut) : ''}`;
}

const asChannel = (s: string): string => (s.startsWith('#') ? s : `#${s}`);

/** `/dm [<nick> [text...]]`. */
export async function runDmCommand(argv: string[], d: RelayCommandDeps): Promise<RelayOutcome> {
  if (!d.signedIn) return { ok: false, error: SIGN_IN };
  const [nick, ...words] = argv;
  if (!nick) {
    const r = await d.relay.dmPartners();
    if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
    if (!r.data.length) { d.out(chalk.dim('  No direct messages yet. Start one: /dm <nick> <text>')); return { ok: true }; }
    for (const p of r.data) d.out(formatPartnerLine(p));
    return { ok: true };
  }
  const who = nick.replace(/^@/, '');
  const text = words.join(' ').trim();
  if (!text) {
    const r = await d.relay.dmHistory(who);
    if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
    if (!r.data.length) { d.out(chalk.dim(`  No messages with ${who} yet.`)); return { ok: true }; }
    d.out(chalk.dim(`── DM with ${who} — last ${r.data.length} ──`));
    for (const m of r.data) d.out(formatDmLine(m));
    return { ok: true };
  }
  const r = await d.relay.sendDm(who, text);
  if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
  d.out(chalk.green(`  ✓ DM to ${who}`) + chalk.dim(r.data.delivered
    ? ' (they are on; delivered live)'
    : ' (saved; they see it when they are back)'));
  return { ok: true };
}

/** `/relay channels|read|send|dm ...` (the verbs that run once). */
export async function runRelayCommand(argv: string[], d: RelayCommandDeps): Promise<RelayOutcome> {
  const verb = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);
  if (!verb) { d.out(chalk.dim(`  ${RELAY_USAGE}`)); return runRelayCommand(['channels'], d); }
  if (verb.startsWith('#')) return runRelayCommand(['read', ...argv], d);   // `awsh relay #ops`
  if (verb === 'dm' || verb === 'dms') return runDmCommand(rest, d);
  if (verb === 'channels') {
    const r = await d.relay.channels(rest[0] || 'platform');
    if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
    if (!r.data.length) { d.out(chalk.dim('  (no channels)')); return { ok: true }; }
    for (const c of r.data) {
      d.out(`  ${chalk.bold(c.name)}${c.topic ? chalk.dim('  ' + c.topic) : ''}`);
    }
    return { ok: true };
  }
  if (verb === 'read') {
    const ch = rest[0];
    if (!ch) return { ok: false, error: RELAY_USAGE };
    const n = Math.max(1, Math.min(200, parseInt(rest[1] || '20', 10) || 20));
    const r = await d.relay.read(asChannel(ch), n);
    if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
    d.out(chalk.dim(`── ${asChannel(ch)} — last ${r.data.length} ──`));
    for (const m of r.data) d.out(formatChannelLine(m));
    return { ok: true };
  }
  if (verb === 'send') {
    const [ch, ...words] = rest;
    const text = words.join(' ').trim();
    if (!ch || !text) return { ok: false, error: RELAY_USAGE };
    if (!d.signedIn) return { ok: false, error: SIGN_IN };
    const r = await d.relay.post(asChannel(ch), text);
    if (!r.ok) return { ok: false, error: `relay: ${r.error}` };
    d.out(chalk.green(`  ✓ sent to ${asChannel(ch)}`));
    return { ok: true };
  }
  return { ok: false, error: RELAY_USAGE };
}
