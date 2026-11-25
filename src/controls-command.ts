/**
 * `aither listen` and `aither registry` -- what Aither hears on this machine, and what
 * she and every agent can call, load and add.
 *
 *   aither listen                  status first, then the switches (five, then "+N more")
 *   aither listen --all            every switch
 *   aither listen mic on|off       unmute / mute the desk microphone
 *   aither listen dnd on|off       desk do-not-disturb
 *   aither listen --json
 *
 *   aither registry                every agent, ranked, with usage flags
 *   aither registry <agent>        her tools, skills, permissions, settings, what to fix
 *   aither registry can <words>    who can do this, and how
 *   aither registry catalogue [words]   what can be added, with the one-step add
 *   aither registry --full | --json
 *
 * Neither command owns any state. `listen` reads the stores that already decide the
 * answer (the desk's cast.json, ~/.aither/posture.json, the awconnect pairing file) and
 * changes a desk switch only through the desk's own command registry, so the tray, the
 * hotkey and this command can never disagree. Every change is appended to
 * ~/.aither/registry/hearing-audit.jsonl (who, when, what, old, new).
 *
 * `registry` reads the two files the monorepo generator publishes for this machine
 * (`gen_agent_capability_registry.py --usage`): ~/.aither/registry/
 * agent_capability_registry.json and usage.json. Without them the answer is the one
 * command that creates them, never a stack trace.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { deskRunCommand } from './awdesk-bridge.js';

export const VISIBLE_CAP = 5;

type Rec = Record<string, any>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

export function aitherHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AITHER_HOME || join(homedir(), '.aither');
}

function readJson(path: string): Rec | null {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return isRec(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Rank is the caller's; this only caps presentation and reports the real remainder. */
export function capList<T>(items: T[], cap: number = VISIBLE_CAP): { shown: T[]; more: number } {
  const shown = items.slice(0, cap);
  return { shown, more: items.length - shown.length };
}

const capText = (items: string[], cap = VISIBLE_CAP): string => {
  if (!items.length) return 'none';
  const { shown, more } = capList(items, cap);
  return shown.join(', ') + (more > 0 ? `  +${more} more` : '');
};

// ── aither listen ───────────────────────────────────────────────────────────

export interface HearingRow {
  key: string;
  label: string;
  value: string;
  detail: string;
  /** true = she is taking something in without being addressed. */
  listening: boolean;
  stored: string;
  /** How to change it from here, or where the control lives. */
  change: string;
}

/** The desk's settings file (Electron userData); DESK_CAST_FILE is its own test seam. */
export function deskCastPath(env: NodeJS.ProcessEnv = process.env,
                             platform: string = process.platform): string {
  if (env.DESK_CAST_FILE) return env.DESK_CAST_FILE;
  if (platform === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Desk', 'cast.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Desk', 'cast.json');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Desk', 'cast.json');
}

export interface HearingSources {
  cast: Rec | null;
  castPath: string;
  posture: Rec | null;
  paired: number | null;
}

export function readHearingSources(env: NodeJS.ProcessEnv = process.env): HearingSources {
  const home = aitherHome(env);
  const castPath = deskCastPath(env);
  const tokens = readJson(join(home, 'awconnect', 'paired_tokens.json'));
  let paired: number | null = null;
  if (tokens) {
    const list = Array.isArray(tokens.tokens) ? tokens.tokens : Object.keys(tokens);
    paired = list.length;
  }
  return { cast: readJson(castPath), castPath, posture: readJson(join(home, 'posture.json')),
           paired };
}

/** Every switch on this machine, most important first. Unreadable = "unknown", never a guess. */
export function hearingRows(src: HearingSources): HearingRow[] {
  const rows: HearingRow[] = [];
  const cast = src.cast;
  const input: Rec = isRec(cast?.input) ? cast!.input : {};
  const overlay: Rec = isRec(cast?.overlay) ? cast!.overlay : {};
  const clip: Rec = isRec(cast?.clipboard) ? cast!.clipboard : {};
  const desk = cast !== null;
  const muted = input.micMuted === true;
  const talk = typeof input.talkMode === 'string' ? input.talkMode : 'toggle';
  const open = desk && !muted && talk === 'open';

  rows.push({
    key: 'mic', label: 'Desk microphone',
    value: !desk ? 'unknown' : muted ? 'muted' : 'on',
    detail: !desk ? 'the desk has not written its settings on this machine'
      : muted ? 'she hears nothing through the desk' : 'she hears you when you talk to her',
    listening: open, stored: src.castPath + ' (input.micMuted)',
    change: desk ? `aither listen mic ${muted ? 'on' : 'off'}` : 'install the desk first',
  });
  rows.push({
    key: 'talk', label: 'Talk mode',
    value: !desk ? 'unknown' : talk,
    detail: talk === 'open' ? 'open mic: listening the whole time the mic is on'
      : talk === 'hold' ? 'she listens only while you hold the talk key'
      : 'she listens after you press the talk key, until you stop',
    listening: open, stored: src.castPath + ' (input.talkMode)',
    change: 'desk Settings > Talk mode',
  });
  const dnd = overlay.doNotDisturb === true;
  rows.push({
    key: 'dnd', label: 'Do not disturb',
    value: !desk ? 'unknown' : dnd ? 'on' : 'off',
    detail: dnd ? 'the desk raises nothing on its own and the fairy stays quiet'
      : 'the desk may raise cards and the fairy may nudge you',
    listening: false, stored: src.castPath + ' (overlay.doNotDisturb)',
    change: desk ? `aither listen dnd ${dnd ? 'off' : 'on'}` : 'install the desk first',
  });
  const word = typeof src.posture?.desired === 'string' ? src.posture!.desired : '';
  rows.push({
    key: 'posture', label: 'House posture',
    value: word || 'unknown',
    detail: word === 'dark' || word === 'game'
      ? 'agents are parked; only the must-answer surfaces reply'
      : word ? 'agents answer on their usual surfaces' : 'no posture file on this machine',
    listening: false, stored: '~/.aither/posture.json',
    change: 'aither posture shop|after|game|dark|auto',
  });
  rows.push({
    key: 'browser', label: 'Browser pages (awconnect)',
    value: src.paired === null ? 'not paired' : `${src.paired} paired`,
    detail: 'an agent sees a page only after you approve that tab; approvals end with the '
      + 'browser session',
    listening: false, stored: '~/.aither/awconnect/paired_tokens.json',
    change: 'aither awconnect pair revoke',
  });
  const sync = clip.sync === true;
  rows.push({
    key: 'clipboard', label: 'Clipboard sync',
    value: !desk ? 'unknown' : sync ? 'on' : 'off',
    detail: sync ? 'what you copy is pushed to your storage' : 'the clipboard stays on this machine',
    listening: sync, stored: src.castPath + ' (clipboard.sync)',
    change: 'desk command clipboard.sync.toggle',
  });
  rows.push({
    key: 'discord', label: 'Discord servers', value: 'per server',
    detail: 'each server has its own switches for chat, voice calls and who sees answers',
    listening: false, stored: 'the bot\'s per-server store',
    change: '/aither settings in that server',
  });
  rows.push({
    key: 'relay', label: 'Relay rooms', value: 'per room',
    detail: 'an agent answers in a room only when it is on that room\'s roster',
    listening: false, stored: 'relay channel roster',
    change: 'the room\'s moderators (roster)',
  });
  return rows;
}

export function formatHearing(rows: HearingRow[], all = false): string[] {
  const on = rows.filter(r => r.listening);
  const lines = [on.length
    ? `Listening on her own: ${on.map(r => r.label.toLowerCase()).join(', ')} `
      + `(${on.length} of ${rows.length} switches).`
    : `Aither hears only what you address to her (0 of ${rows.length} switches listening).`];
  const { shown, more } = capList(rows, all ? rows.length : VISIBLE_CAP);
  shown.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.label}: ${r.value} - ${r.detail}. Change: ${r.change}`);
  });
  if (more > 0) lines.push(`+${more} more (aither listen --all)`);
  const mic = rows.find(r => r.key === 'mic');
  lines.push(on.length && mic?.value === 'on'
    ? 'Next: `aither listen mic off` stops the desk hearing you.'
    : 'Next: nothing needs changing. `aither listen --all` shows every switch.');
  return lines;
}

export interface ListenDeps {
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  read?: () => HearingSources;
  runDesk?: (id: string) => Promise<unknown>;
  auditPath?: string;
  now?: () => number;
  who?: () => string;
}

/** The two desk switches this command may flip, and the desk command that toggles each. */
export const LISTEN_SWITCHES: Readonly<Record<string, { command: string; label: string }>> =
  Object.freeze({
    mic: { command: 'audio.mic.mute', label: 'Desk microphone' },
    dnd: { command: 'desktop.overlay.dnd', label: 'Do not disturb' },
  });

function currentSwitch(src: HearingSources, key: string): 'on' | 'off' | null {
  if (!src.cast) return null;
  const input: Rec = isRec(src.cast.input) ? src.cast.input : {};
  const overlay: Rec = isRec(src.cast.overlay) ? src.cast.overlay : {};
  if (key === 'mic') return input.micMuted === true ? 'off' : 'on';
  return overlay.doNotDisturb === true ? 'on' : 'off';
}

export async function runListenCommand(args: string[], deps: ListenDeps = {}): Promise<number> {
  const env = deps.env || process.env;
  const print = deps.print || ((l: string) => console.log(l));
  const read = deps.read || (() => readHearingSources(env));
  const positional = args.filter(a => !a.startsWith('--'));
  if (!positional.length) {
    const rows = hearingRows(read());
    if (args.includes('--json')) {
      print(JSON.stringify({ rows, total: rows.length }, null, 2));
      return 0;
    }
    for (const line of formatHearing(rows, args.includes('--all'))) print(line);
    return 0;
  }
  const key = positional[0].toLowerCase();
  const want = (positional[1] || '').toLowerCase();
  const sw = LISTEN_SWITCHES[key];
  if (!sw || (want !== 'on' && want !== 'off')) {
    print('usage: aither listen [--all|--json] | aither listen mic on|off | aither listen dnd on|off');
    return 2;
  }
  const before = currentSwitch(read(), key);
  if (before === null) {
    print(`${sw.label}: the desk has not written its settings here - start the desk, then retry.`);
    return 1;
  }
  if (before === want) {
    print(`${sw.label} is already ${want}.`);
    return 0;
  }
  try {
    await (deps.runDesk || ((id: string) => deskRunCommand(id)))(sw.command);
  } catch (e: unknown) {
    print(`${sw.label} not changed: ${e instanceof Error ? e.message : String(e)} - `
      + 'is the desk running? (`aither desk status`)');
    return 1;
  }
  const after = currentSwitch(read(), key);
  const auditPath = deps.auditPath || join(aitherHome(env), 'registry', 'hearing-audit.jsonl');
  const entry = {
    at: Math.floor((deps.now || Date.now)() / 1000),
    by: (deps.who || (() => userInfo().username))(), via: 'awsh', what: key,
    old: before, new: after ?? want, confirmed: after === want,
  };
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e: unknown) {
    print(`changed, but the audit line could not be written: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  print(after === want
    ? `${sw.label} is now ${want} (was ${before}). Recorded in ${auditPath}.`
    : `${sw.label}: the desk took the command but its settings still read ${after}; `
      + 'check the desk tray.');
  return after === want ? 0 : 1;
}

// ── aither registry ─────────────────────────────────────────────────────────

export const REGISTRY_REFRESH =
  'python AitherOS/dev/tools/gen_agent_capability_registry.py --usage';

export interface RegistryFiles { registry: Rec | null; usage: Rec | null; dir: string }

export function readRegistryFiles(env: NodeJS.ProcessEnv = process.env): RegistryFiles {
  const dir = join(aitherHome(env), 'registry');
  return {
    registry: readJson(join(dir, 'agent_capability_registry.json')),
    usage: readJson(join(dir, 'usage.json')), dir,
  };
}

const ago = (ts: number, now: number): string => {
  if (!ts) return 'never';
  const days = Math.floor((now - ts) / 86400);
  return days <= 0 ? 'today' : `${days}d ago`;
};

export function registryOverview(reg: Rec, usage: Rec | null, full = false): string[] {
  const c: Rec = reg.counts || {};
  const agents = Object.entries(reg.agents || {}) as [string, Rec][];
  agents.sort((a, b) => Number(b[0] === 'aither') - Number(a[0] === 'aither')
    || Number(b[1].in_roster) - Number(a[1].in_roster)
    || b[1].tool_count - a[1].tool_count || a[0].localeCompare(b[0]));
  const lines = [`Registry: ${c.agents} agents (${c.agents_in_roster} in the roster), `
    + `${c.tools} tools, ${c.skills} skills, ${c.catalogue} things to add. `
    + `${c.phantom_grants} granted tool names do not exist.`];
  const { shown, more } = capList(agents, full ? agents.length : VISIBLE_CAP);
  shown.forEach(([name, a], i) => {
    lines.push(`${i + 1}. ${name} (${a.role || 'agent'}): ${a.tool_count} tools`
      + `${a.tools === '*' ? ' (all)' : ''}, profile ${capText(a.tool_profile || [], 3)}`);
  });
  if (more > 0) lines.push(`+${more} more (of ${agents.length}; aither registry --full)`);
  const f: Rec | null = usage && isRec(usage.flags) ? usage.flags : null;
  if (f && f.tools_measured) {
    lines.push(`Usage, last ${usage!.window_days}d: ${f.tools_called} of ${f.tools_total} tools `
      + `called, ${f.failing_tools.length} failing (>20% errors), `
      + `${(f.dead_tools || []).length} granted and never called.`);
    const failing = capList<Rec>(f.failing_tools, full ? f.failing_tools.length : VISIBLE_CAP);
    failing.shown.forEach((r, i) => {
      lines.push(`  failing ${i + 1}. ${r.tool}: ${r.failures} of ${r.calls} calls failed`);
    });
    if (failing.more > 0) lines.push(`  +${failing.more} more failing`);
    lines.push(f.skills_measured
      ? `Skills never loaded: ${(f.skills_never_loaded || []).length} of ${c.skills}.`
      : 'Skills never loaded: not measured (transcripts were read only in part).');
  } else {
    lines.push(`Usage: not measured on this machine - run \`${REGISTRY_REFRESH}\`.`);
  }
  lines.push('Next: `aither registry aither` shows what Aither herself can call.');
  return lines;
}

export function registryAgent(reg: Rec, usage: Rec | null, agent: string, full = false,
                              now: number = Date.now() / 1000): { code: number; lines: string[] } {
  const cap = full ? Number.MAX_SAFE_INTEGER : VISIBLE_CAP;
  const a: Rec | undefined = (reg.agents || {})[agent];
  if (!a) {
    const h: Rec | undefined = (reg.harness_agents || {})[agent];
    if (h) {
      return { code: 0, lines: [
        `${agent} (local subagent): ${h.description}`,
        `1. Tools: ${h.tools === '*' ? 'every tool the session has' : capText(h.tools, cap)}`,
        `2. Defined in: ${h.path}`,
        'Next: edit that file\'s `tools:` line to change what it may call.'] };
    }
    const near = [...Object.keys(reg.agents || {}), ...Object.keys(reg.harness_agents || {})]
      .filter(n => n.toLowerCase().includes(agent.toLowerCase()));
    return { code: 1, lines: [`No agent named '${agent}' - `
      + (near.length ? `did you mean ${capText(near)}` : '`aither registry` lists them') + '.'] };
  }
  const s: Rec = a.settings || {};
  const p: Rec = a.permissions || {};
  const used: Rec = (usage && isRec(usage.tools)) ? usage.tools : {};
  const tools: string[] = a.tools === '*' ? Object.keys(reg.tools || {}).sort() : [...a.tools];
  tools.sort((x, y) => ((used[y]?.calls || 0) - (used[x]?.calls || 0)) || x.localeCompare(y));
  const { shown, more } = capList(tools, cap);
  const total = Object.keys(reg.tools || {}).length;
  const lines = [`${agent} (${a.role || 'agent'}${a.family ? ', ' + a.family : ''}): can call `
    + `${a.tool_count} of ${total} tools${a.tools === '*' ? ' (all)' : ''}; `
    + `${a.in_roster ? 'in the roster' : 'not in the public roster'}.`];
  lines.push('1. Tools: ' + (shown.map(n => {
    const u = used[n];
    return u ? `${n} (${u.calls} calls, ${u.failures} failed, last ${ago(u.last_used, now)})` : n;
  }).join(', ') || 'none granted') + (more > 0 ? `  +${more} more` : ''));
  const own: string[] = (a.advertised_skills || []).map((k: Rec) => String(k.id));
  lines.push(`2. Skills: advertises ${own.length} (${capText(own, cap)})`);
  lines.push('3. Permissions: ' + (p.has_token_profile
    ? `${(p.grants || []).length} grants, max tier ${s.max_tier || 'unset'}; `
      + `denies: ${capText(p.denies || [], cap)}`
    : 'no capability profile - default deny'));
  lines.push(`4. Settings: effort cap ${s.effort_cap}, budget ${s.hourly_budget}/h `
    + `${s.daily_budget}/day, spawn ${s.can_spawn ? 'yes' : 'no'}, delegate `
    + `${s.can_delegate ? 'yes' : 'no'}, profile ${capText(a.tool_profile || [], cap)}`);
  const issues: string[] = [];
  if ((a.phantom_grants || []).length) {
    issues.push(`${a.phantom_grants.length} grants name a tool that does not exist `
      + `(${capText(a.phantom_grants, 3)})`);
  }
  if ((a.declared_not_granted || []).length) {
    issues.push(`${a.declared_not_granted.length} declared tools have no grant `
      + `(${capText(a.declared_not_granted, 3)})`);
  }
  lines.push('5. To fix: ' + (issues.join('; ') || 'nothing flagged'));
  lines.push(`Next: change grants in AitherOS/config/capabilities.yaml (agents.${agent}), `
    + 'then regenerate the registry.');
  return { code: 0, lines };
}

const wordsOf = (text: string, min = 2): string[] =>
  (text.toLowerCase().match(/[a-z0-9_]+/g) || []).filter(w => w.length > min);

export function registryCan(reg: Rec, thing: string): { code: number; lines: string[] } {
  const words = wordsOf(thing);
  if (!words.length) return { code: 2, lines: ['Say what, in a few words: aither registry can send an email'] };
  const score = (name: string, desc: string): number => {
    const nm = name.toLowerCase();
    const ds = (desc || '').toLowerCase();
    return words.reduce((n, w) => n + (nm.includes(w) ? 3 : ds.includes(w) ? 1 : 0), 0);
  };
  const floor = Math.max(2, words.length);
  const hits: Array<{ s: number; kind: string; name: string }> = [];
  for (const [n, t] of Object.entries(reg.tools || {}) as [string, Rec][]) {
    const s = score(n, t.description);
    if (s >= floor) hits.push({ s, kind: 'tool', name: n });
  }
  for (const [n, k] of Object.entries(reg.skills || {}) as [string, Rec][]) {
    const s = score(n, k.description);
    if (s >= floor) hits.push({ s, kind: 'skill', name: n });
  }
  hits.sort((a, b) => b.s - a.s || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  if (!hits.length) {
    return { code: 1, lines: [`Nothing in the registry matches '${thing}' - no tool or skill `
      + 'does this yet. Next: `aither registry catalogue` shows what can be added.'] };
  }
  const lines = [`${hits.length} match(es) for '${thing}'.`];
  const { shown, more } = capList(hits);
  shown.forEach((h, i) => {
    if (h.kind === 'tool') {
      const who = (Object.entries(reg.agents || {}) as [string, Rec][])
        .filter(([, a]) => a.tools === '*' || a.tools.includes(h.name)).map(([n]) => n).sort();
      lines.push(`${i + 1}. tool ${h.name} - ${reg.tools[h.name].description} Who: `
        + (who.length ? `${capText(who)} (${who.length} agents)` : 'no agent is granted it'));
    } else {
      const k: Rec = reg.skills[h.name];
      lines.push(`${i + 1}. skill ${h.name} - ${k.description} Who: `
        + (k.kind === 'harness' ? 'any coding session in this repo' : 'any fleet agent, by pattern'));
    }
  });
  if (more > 0) lines.push(`+${more} more`);
  lines.push('Next: ask the first agent listed, or `aither registry <agent>` for its full reach.');
  return { code: 0, lines };
}

export function registryCatalogue(reg: Rec, usage: Rec | null, query: string,
                                  full = false): { code: number; lines: string[] } {
  const terms = wordsOf(query, 1);
  const have = new Set<string>(usage && Array.isArray(usage.installed) ? usage.installed : []);
  const known = !!(usage && Array.isArray(usage.installed));
  const entries = Object.entries(reg.catalogue || {}) as [string, Rec][];
  const rows = entries
    .filter(([name, c]) => {
      const text = `${name} ${c.name || ''} ${c.description || ''}`.toLowerCase();
      return terms.every(t => text.includes(t));
    })
    .map(([name, c]) => {
      const state = have.has(name) ? 'installed' : c.add ? 'available' : 'not addable yet';
      return { name, c, state, rank: state === 'available' ? 0 : state === 'installed' ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  if (!rows.length) {
    return { code: 1, lines: [`Nothing in the catalogue matches '${query}' (${entries.length} `
      + 'entries). Next: `aither registry catalogue` lists what can be added.'] };
  }
  const addable = rows.filter(r => r.state === 'available');
  const lines = [`Catalogue: ${rows.length} of ${entries.length} entries`
    + (terms.length ? ` match '${query}'` : '') + `; ${addable.length} can be added in one step`
    + (known ? `, ${rows.filter(r => r.state === 'installed').length} installed here.`
      : ' (installed state: not checked on this machine).')];
  const { shown, more } = capList(rows, full ? rows.length : VISIBLE_CAP);
  shown.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.c.name || r.name} [${r.state}] - ${r.c.description}`
      + (r.state === 'available' ? `  Add: ${r.c.add}` : '')
      + (r.c.missing && r.state !== 'installed' ? `  (${r.c.missing})` : ''));
  });
  if (more > 0) lines.push(`+${more} more (add words to narrow, or --full)`);
  lines.push(addable.length ? `Next: ${addable[0].c.add}`
    : 'Next: nothing here has a one-step add yet.');
  return { code: 0, lines };
}

export interface RegistryDeps {
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  read?: () => RegistryFiles;
}

export async function runRegistryCommand(args: string[], deps: RegistryDeps = {}): Promise<number> {
  const print = deps.print || ((l: string) => console.log(l));
  const files = (deps.read || (() => readRegistryFiles(deps.env || process.env)))();
  const full = args.includes('--full');
  const positional = args.filter(a => !a.startsWith('--'));
  if (!files.registry) {
    print(`No registry on this machine yet (${files.dir}). `
      + `Next: from the repo, run \`${REGISTRY_REFRESH}\`.`);
    return 1;
  }
  const reg = files.registry;
  if (args.includes('--json')) {
    const agent = positional[0];
    print(JSON.stringify(agent
      ? { agent, registry: (reg.agents || {})[agent] || (reg.harness_agents || {})[agent] || null }
      : { counts: reg.counts, flags: files.usage?.flags ?? null }, null, 2));
    return 0;
  }
  const verb = (positional[0] || '').toLowerCase();
  let out: { code: number; lines: string[] };
  if (!verb) out = { code: 0, lines: registryOverview(reg, files.usage, full) };
  else if (verb === 'can') out = registryCan(reg, positional.slice(1).join(' '));
  else if (verb === 'catalogue' || verb === 'catalog' || verb === 'add') {
    out = registryCatalogue(reg, files.usage, positional.slice(1).join(' '), full);
  } else out = registryAgent(reg, files.usage, positional[0], full);
  for (const line of out.lines) print(line);
  return out.code;
}
