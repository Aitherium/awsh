/**
 * grounding.ts — the platform context every awsh turn carries.
 *
 * Measured 2026-11-16 (owner screenshots, 20:41-21:07): awsh answered "status of
 * darkmatter demo?" with "run docker ps / kubectl", called DarkMatter "not a widely
 * recognized engine… maybe Dark Souls", said "no email tool is connected" and "No" to
 * "are you connected to discord?". Two causes: the turn went to the bare edge gateway
 * (no tools; fixed in backend-resolver.ts), and nothing told the model who it works for,
 * what his products are, or which platform tool answers which question. Even on the
 * local agent daemon (68 platform tools) it searched with an empty query and gave up.
 *
 * This module is that missing context:
 *   - PLATFORM_CONTEXT: who David is, his products, the rules (call a tool, never tell
 *     him to run docker/kubectl, "I don't know" + a tool call beats a guess).
 *   - routeHint(message): a deterministic first-tool hint for the questions he asks
 *     daily. Pure; the regression tests pin the exact screenshot prompts.
 *   - liveSnapshot(): loopback probes (DarkMatter :8799, daemon :9001, harness :8362,
 *     gateway :8182, awdesk :47931), cached, so a status question has real facts even
 *     before the first tool call.
 *   - recallFor(message): `awm recall` for the owner's scope, bounded; late answers
 *     land on the next turn instead of stalling this one.
 *
 * AWSH_GROUNDING=0 turns all of it off (a pack that wants a blank model).
 */

import { spawn } from 'node:child_process';

export const PLATFORM_CONTEXT = [
  '## Who you work for and where you are (awsh platform context)',
  'You are Aither, running inside awsh (AitherShell) on David Parkhurst\'s own machine. David is the',
  'owner and founder of Aitherium; AitherOS is HIS platform, and this shell is his daily driver into it.',
  'His products (never guess what these are; they are his):',
  '- DarkMatter (also "Dark Matters"): his own 3D game engine + game. The game server is the',
  '  game-server quadlet on the awnix fleet, played at http://localhost:8799 (health: /health).',
  '  Agents are meant to spawn into it with eyes and hands. It is NOT Dark Souls or any third-party engine.',
  '- A partner world: a film + sovereign bot for a partner engineering group (never guess what it is).',
  '- openAW (openaw.org): the open agent-work network with project channels; the current #1 roadmap item.',
  '- Wesyn: worlds (never "planets") built on real data; Occupy SaaS is the first connected world.',
  '- Aionyn: the social layer (verified humans + labeled agents). Eusyra: the Discord sticker/emoji/soundboard pipeline.',
  '- awdesk: his desktop with the avatar (aither-v2 VRM) and fairies. awdk: the agent daemon (127.0.0.1:9001)',
  '  and harness (127.0.0.1:8362). The Aither Discord bot and relay bridge are his Discord presence.',
  'Rules for every answer:',
  '1. You HAVE platform tools. For any question about his systems, mail, Discord, fleet, games, memory or',
  '   desk, call a tool first (call_tool / load_tools / search_tools with a REAL query, never empty).',
  '2. Never tell David to run docker, podman, kubectl or curl himself. You run the check, then report.',
  '3. "I do not know yet" plus a tool call beats a guess. Never invent what a product of his is.',
  '4. Answer short: the result first, then one line of evidence (which tool, what it returned).',
].join('\n');

export interface RouteHint {
  /** Short id for tests/telemetry: darkmatter | mail | discord | capabilities | fleet | memory | desk | workspace | harness */
  topic: string;
  /** The gateway/daemon tool names to try first, best first. */
  tools: string[];
  /** One instruction line appended to this turn's system additions. */
  line: string;
}

const ROUTES: { topic: string; re: RegExp; tools: string[]; line: string }[] = [
  {
    topic: 'darkmatter',
    re: /\bdark\s*matters?\b|\bdarkmatter\b|:8799\b/i,
    tools: ['http_get', 'fleet_status', 'recall'],
    line: 'DarkMatter is David\'s game engine/game (a game-server quadlet, :8799). Use the live snapshot '
      + 'below, then call_tool http_get http://aitheros-dark-matters:8799/health or fleet_status, and recall '
      + '"darkmatter demo" for the demo plan. Report what you measured.',
  },
  {
    topic: 'mail',
    re: /\b(e-?mail|inbox|mailbox|unread)\b/i,
    tools: ['mail_triage', 'mail_list', 'workspace_mail_list_messages'],
    line: 'Mail: call_tool mail_triage (then mail_list / workspace_mail_list_messages). His mail IS connected '
      + 'through the platform; never say "no email tool".',
  },
  {
    topic: 'discord',
    re: /\bdiscord\b|\bdm\b|\brelay\b/i,
    tools: ['atlas_presence', 'relay_history', 'relay_channels', 'relay_send'],
    line: 'Discord: call_tool atlas_presence (bot status) and relay_history / relay_channels (recent messages). '
      + 'Posting as Aither (relay_send / discord_post) needs David\'s explicit yes in this chat first.',
  },
  {
    topic: 'capabilities',
    re: /\bwhat (can|do) you do\b|\bwhat are you able\b|\byour (tools|capabilities)\b|\bhelp me with what\b/i,
    tools: ['answer from the platform list (no tool needed)'],
    line: 'Capabilities: answer DIRECTLY from this list, no web search (the web does not know his machine): '
      + 'his fleet (fleet_status), mail (mail_triage), Discord via the Aither bot and relay (atlas_presence, '
      + 'relay_history, relay_send with his yes), memory (recall/awm), decision cards (decisions_list), '
      + 'DarkMatter on :8799, the awdesk avatar (speak), agents and harness sessions (awsh_spawn), workspace '
      + 'scope (get_active_workspace_profile). Add one line per item on what you would do now; name real tools.',
  },
  {
    topic: 'workspace',
    re: /\bworkspace\b|\bprofile\b|\bhearth\b|\bfamily\b/i,
    tools: ['get_active_workspace_profile', 'list_workspace_profiles'],
    line: 'Workspace: call_tool get_active_workspace_profile; every workspace_* tool is scoped to it.',
  },
  {
    topic: 'desk',
    re: /\b(awdesk|desk|avatar|fairy|fairies|speak|say it)\b/i,
    tools: ['speak', 'desk_command', 'list_agent_avatars'],
    line: 'Desk: the awdesk avatar is driven with call_tool speak / desk_command; fairies are desk agents.',
  },
  {
    topic: 'harness',
    re: /\b(awdk|daemon|harness|spawn|sessions?|agents?)\b/i,
    tools: ['awsh_sessions', 'awsh_spawn', 'awsh_harnesses', 'agent_roster'],
    line: 'Agents/harness: call_tool awsh_sessions / awsh_harnesses / agent_roster; spawn with awsh_spawn.',
  },
  {
    topic: 'fleet',
    re: /\b(status|health|fleet|down|up|running|containers?|services?|outage)\b/i,
    tools: ['fleet_status', 'get_platform_health'],
    line: 'Fleet: call_tool fleet_status or get_platform_health and report what is down, never "run docker ps".',
  },
  {
    topic: 'memory',
    re: /\b(remember|recall|last time|we decided|what did i)\b/i,
    tools: ['recall', 'awm_recall', 'query_memory'],
    line: 'Memory: call_tool recall / awm_recall with his words as the query before answering.',
  },
];

/** The first-tool hint for a message, or null for chit-chat. Pure. */
export function routeHint(message: string): RouteHint | null {
  const m = String(message || '');
  for (const r of ROUTES) if (r.re.test(m)) return { topic: r.topic, tools: r.tools, line: r.line };
  return null;
}

// ── live snapshot ────────────────────────────────────────────────────────

export interface ProbeTarget { name: string; url: string }

export const LIVE_TARGETS: ProbeTarget[] = [
  { name: 'DarkMatter game (:8799)', url: 'http://127.0.0.1:8799/health' },
  { name: 'awdk agent daemon (:9001)', url: 'http://127.0.0.1:9001/health' },
  { name: 'awdk harness (:8362)', url: 'http://127.0.0.1:8362/health' },
  { name: 'MCP gateway (:8182)', url: 'http://127.0.0.1:8182/health' },
  { name: 'awdesk (:47931)', url: 'http://127.0.0.1:47931/health' },
];

/** Format probe results as one system block. Pure. */
export function formatSnapshot(rows: { name: string; up: boolean; detail?: string }[], at: Date): string {
  if (!rows.length) return '';
  const lines = rows.map((r) => `- ${r.name}: ${r.up ? 'UP' : 'DOWN / not answering'}${r.detail ? ` (${r.detail})` : ''}`);
  return `## Live snapshot from this machine (${at.toISOString()}, measured by awsh)\n${lines.join('\n')}`;
}

let _snap: { at: number; text: string } | null = null;
let _snapInFlight: Promise<string> | null = null;
const SNAP_TTL_MS = 60_000;

async function probeOne(t: ProbeTarget, timeoutMs: number): Promise<{ name: string; up: boolean; detail?: string }> {
  try {
    const r = await fetch(t.url, { signal: AbortSignal.timeout(timeoutMs) });
    return { name: t.name, up: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}` };
  } catch { return { name: t.name, up: false }; }
}

/** Cached loopback probes. Never throws; '' when every probe failed to run. */
export async function liveSnapshot(targets: ProbeTarget[] = LIVE_TARGETS, timeoutMs = 1500): Promise<string> {
  if (_snap && Date.now() - _snap.at < SNAP_TTL_MS) return _snap.text;
  if (_snapInFlight) return _snapInFlight;
  _snapInFlight = (async () => {
    const rows = await Promise.all(targets.map((t) => probeOne(t, timeoutMs)));
    const text = formatSnapshot(rows, new Date());
    _snap = { at: Date.now(), text };
    return text;
  })().finally(() => { _snapInFlight = null; });
  return _snapInFlight;
}

// ── awm recall ───────────────────────────────────────────────────────────

/** The owner's awm scope: AWM_USER, else the signed-in user's first name, lowercased. Pure. */
export function awmScope(env: NodeJS.ProcessEnv, authUser?: string | null): string | null {
  const explicit = (env.AWSH_AWM_SCOPE || '').trim();
  if (explicit) return explicit;
  const user = (env.AWM_USER || (authUser || '').split(/[\s@._-]/)[0] || '').trim().toLowerCase();
  if (!user || !/^[a-z0-9]+$/.test(user)) return null;
  return `aitherium:${user}:AitherOS-Fresh`;
}

/** Keep only the fact lines from `awm recall` output (they start with a [score]). Pure. */
export function parseRecall(stdout: string, max = 5): string[] {
  return String(stdout || '').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\[\d+(\.\d+)?\]/.test(l))
    .slice(0, max)
    .map((l) => (l.length > 300 ? l.slice(0, 300) + '…' : l));
}

const _recallCache = new Map<string, string[]>();

function runAwmRecall(scope: string, query: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string[]) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn('awm', ['recall', '--scope', scope, '--query', query.slice(0, 200), '--limit', '5'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(parseRecall(out)); }, timeoutMs);
      p.stdout?.on('data', (d) => { out += String(d); });
      p.on('error', () => { clearTimeout(timer); finish([]); });
      p.on('close', () => { clearTimeout(timer); finish(parseRecall(out)); });
    } catch { finish([]); }
  });
}

/** Recall for this message, waiting at most `waitMs`; the full run keeps going (up to
 *  `runMs`) and its result is cached for the next turn on the same topic. */
export async function recallFor(message: string, scope: string | null, waitMs = 2500, runMs = 12_000): Promise<string[]> {
  if (!scope) return [];
  const key = (routeHint(message)?.topic || message).slice(0, 80).toLowerCase();
  const cached = _recallCache.get(key);
  if (cached) return cached;
  const run = runAwmRecall(scope, message, runMs).then((facts) => { _recallCache.set(key, facts); return facts; });
  const late = new Promise<string[]>((r) => setTimeout(() => r([]), waitMs));
  return Promise.race([run, late]);
}

// ── assembly ─────────────────────────────────────────────────────────────

export interface GroundingInput {
  message: string;
  user?: string | null;
  workspace?: string | null;
  snapshot?: string;
  recall?: string[];
}

/** The system additions for one turn, in a stable order (static context first so the
 *  backend's prompt cache keeps it). Pure. */
export function buildGrounding(i: GroundingInput): string[] {
  const out = [PLATFORM_CONTEXT];
  const who: string[] = [];
  if (i.user) who.push(`Signed in as: ${i.user}.`);
  if (i.workspace) who.push(`Active workspace: ${i.workspace} (workspace_* tools, mail, tasks, secrets and memory are scoped to it).`);
  if (who.length) out.push(who.join(' '));
  const hint = routeHint(i.message);
  if (hint) out.push(`## For this message\n${hint.line}\nTry first: ${hint.tools.join(', ')}.`);
  if (i.snapshot) out.push(i.snapshot);
  if (i.recall && i.recall.length) out.push(`## Recalled from David's memory (awm)\n${i.recall.map((f) => `- ${f}`).join('\n')}`);
  return out;
}

/** On unless AWSH_GROUNDING=0. Off by default under `node --test` (NODE_TEST_CONTEXT),
 *  so unit tests never spawn awm or probe loopback; AWSH_GROUNDING=1 forces it on. */
export function groundingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AWSH_GROUNDING || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !env.NODE_TEST_CONTEXT;
}

/** Everything for one turn, bounded (~2.5 s worst case, usually the cached snapshot). Never throws. */
export async function groundingForTurn(message: string, opts: { user?: string | null; workspace?: string | null } = {}): Promise<string[]> {
  if (!groundingEnabled()) return [];
  try {
    const [snapshot, recall] = await Promise.all([
      liveSnapshot(),
      recallFor(message, awmScope(process.env, opts.user)),
    ]);
    return buildGrounding({ message, user: opts.user, workspace: opts.workspace, snapshot, recall });
  } catch {
    return [PLATFORM_CONTEXT];
  }
}
