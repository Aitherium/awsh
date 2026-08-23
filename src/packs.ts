/**
 * packs.ts — `awsh <pack>` launches the shell wearing a different brain.
 *
 * THE POINT. A pack is what makes this an ALT SHELL rather than one assistant
 * with a costume: `awsh gobbonet` starts a session whose persona, house rules and
 * default agent come from that pack, the way `bash` and `fish` are the same idea
 * with different opinions. The pack is data, so adding one is a file, not a
 * release.
 *
 * WHERE PACKS LIVE. Two roots, on purpose, and both are read:
 *   - awdk/adk/packs/<name>/brain_pack.yaml   — the agent packs awdk already ships
 *   - AitherOS/Library/packs/<name>/…         — the platform's own pack library
 * Neither is authoritative over the other; the first match by name wins and the
 * resolver says which root it came from, so a shadowed pack is visible rather
 * than mysterious.
 *
 * WHY THE PARSER IS TINY AND NOT js-yaml. This package ships to npm and its
 * dependency list is its install cost; a YAML engine to read four top-level keys
 * is not worth it. So this reads exactly the shape brain_pack.yaml uses — plain
 * `key: value` and `key: |` block scalars at the top level — and IGNORES
 * everything else rather than guessing. A pack whose prompt does not parse is
 * reported as unusable, never silently launched with an empty brain: a shell that
 * says it loaded a persona and did not is worse than one that refuses.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** One command a pack contributes. `run` executes a shell command from the
 *  repo root; `url` opens a browser. A command with neither is refused at
 *  parse time rather than registered as a no-op -- a menu entry that does
 *  nothing is worse than an absent one, because the user cannot tell. */
export interface PackCommand {
  name: string;
  description?: string;
  run?: string;
  url?: string;
}

export interface Pack {
  /** Directory name — what the user types. */
  name: string;
  /** Script that launches the pack's FULL app, relative to the tree root. */
  /** Commands this pack contributes to the shell. Optional: a pack that
   *  declares none behaves exactly as before. */
  commands?: PackCommand[];
  appScript?: string;
  /** URL the app serves once it is up, polled to prove it started. */
  appUrl?: string;
  /** File holding the app's access secret, relative to the tree root. */
  appSecretFile?: string;
  /** Backend the app's inference proxy should target. */
  appLlmPort?: string;
  appLlmModel?: string;
  /** File holding the bearer for that backend (supports a leading ~). */
  appLlmKeyFile?: string;
  /** A companion process started alongside the app (e.g. its search proxy). */
  appSidecarScript?: string;
  appSearchPort?: string;
  appSearchService?: string;
  /** Human title from the manifest, if it carries one. */
  title?: string;
  /** Agent identity the backend should adopt (`persona` on the genesis path). */
  identity?: string;
  /** The system prompt. A pack without one is not usable. */
  systemPrompt?: string;
  /** Absolute path to the manifest, so a confused user can go read it. */
  manifest: string;
  /** Which root it came from, so shadowing is visible. */
  root: string;
}

/** Repo roots that hold packs, in resolution order. */
/** The two places a checkout keeps packs, relative to a tree root. */
function rootsUnder(base: string): string[] {
  return [
    join(base, 'awdk', 'adk', 'packs'),
    join(base, 'AitherOS', 'Library', 'packs'),
  ];
}

/**
 * The tree this build of awsh actually came from, found by walking UP from this
 * module until a directory carries a pack root.
 *
 * WHY THIS EXISTS. `$AITHEROS_ROOT` is a user-settable pointer and it goes
 * stale. Measured 2026-08-21: a shell profile still exported a tree on a drive
 * that had been demoted to bulk data, so awsh listed 12 packs from there and
 * showed NONE of the 82 sitting beside the code it was executing -- typing a
 * real pack name fell through to the agent, which guessed it was a typo for a
 * different command. Nothing looked broken: the list rendered, the packs it
 * named were real, and the missing ones were simply absent.
 *
 * Walking up beats a fixed `../..`: the same source runs from `dist/` here, from
 * a flattened image layout elsewhere, and from a global npm install, and a
 * hardcoded depth silently resolves to the wrong directory in two of the three.
 */
function selfTreeRoot(): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;                                  // bundled/eval'd — no own path
  }
  for (let i = 0; i < 8; i++) {
    if (rootsUnder(dir).some((r) => existsSync(r))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Every place to look for packs, in priority order.
 *
 * A UNION, deliberately, deduped by name in discoverPacks(): an explicitly-set
 * root and the tree awsh was built from can BOTH be right, and letting either
 * one hide the other is what produced the stale-pointer failure above. A pack
 * that exists should be listed; which copy wins is a separate question, settled
 * by first-wins ordering.
 */
export function packRoots(repoRoot: string): string[] {
  const out: string[] = [];
  const push = (r: string) => { if (r && !out.includes(r)) out.push(r); };

  // 1. An explicit override always wins.
  if (process.env.AWSH_PACKS_DIR) push(process.env.AWSH_PACKS_DIR);
  // 2. The caller's root ($AITHEROS_ROOT or cwd).
  rootsUnder(repoRoot).forEach(push);
  // 3. The tree this build came from -- never invisible, whatever the env says.
  const self = selfTreeRoot();
  if (self) rootsUnder(self).forEach(push);
  return out;
}

/**
 * Parse the handful of top-level keys a pack manifest carries.
 *
 * Deliberately narrow: `key: value` and `key: |` block scalars at indent 0. A
 * nested structure is skipped rather than half-read, because a half-read prompt
 * is the failure this whole file exists to avoid.
 */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z_][a-z0-9_]*):\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      // Block scalar: take the indented run that follows.
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') { body.push(''); continue; }
        if (!/^\s/.test(l)) break;               // dedented → block ended
        body.push(l.replace(/^ {1,4}/, ''));
      }
      out[key] = body.join('\n').trim();
      continue;
    }
    if (rest) out[key] = rest.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}


/** Parse a `commands:` list out of a manifest.
 *
 * Separate from parseManifest on purpose: that is a flat key -> string
 * reader and cannot express a list of maps. Pulling in a general YAML
 * parser would change how all 82 packs are read to serve a block none of
 * them use yet, so this reads the one block it needs and nothing else.
 *
 * Shape:
 *     commands:
 *       - name: docs
 *         description: Open the handbook
 *         url: https://example.invalid/handbook
 */
export function parsePackCommands(text: string): PackCommand[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^commands:\s*$/.test(l));
  if (start < 0) return [];
  const out: PackCommand[] = [];
  let cur: PackCommand | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) break;              // dedented -> block ended
    const item = /^\s*-\s*name:\s*(.+)$/.exec(l);
    if (item) {
      if (cur) out.push(cur);
      cur = { name: item[1].replace(/^["']|["']$/g, '').trim() };
      continue;
    }
    const kv = /^\s+([a-z_]+):\s*(.+)$/.exec(l);
    if (kv && cur) {
      const v = kv[2].replace(/^["']|["']$/g, '').trim();
      if (kv[1] === 'description') cur.description = v;
      else if (kv[1] === 'run') cur.run = v;
      else if (kv[1] === 'url') cur.url = v;
    }
  }
  if (cur) out.push(cur);
  // A command with no action is refused, not registered. Registering it
  // would put an entry in the menu that silently does nothing, and the user
  // has no way to tell that from a broken command.
  return out.filter(c => c.name && (c.run || c.url));
}
function readPack(dir: string, name: string, root: string): Pack | null {
  for (const candidate of ['brain_pack.yaml', 'pack.yaml', `${name}.yaml`]) {
    const manifest = join(dir, candidate);
    if (!existsSync(manifest)) continue;
    let fields: Record<string, string> = {};
    try {
      fields = parseManifest(readFileSync(manifest, 'utf-8'));
    } catch {
      return { name, manifest, root };          // present but unreadable → unusable
    }
    return {
      name,
      title: fields.app_name || fields.name,
      identity: fields.identity,
      systemPrompt: fields.system_prompt,
      commands: parsePackCommands(readFileSync(manifest, 'utf-8')),
      appScript: fields.app_script,
      appUrl: fields.app_url,
      appSecretFile: fields.app_secret_file,
      appLlmPort: fields.app_llm_port,
      appLlmModel: fields.app_llm_model,
      appLlmKeyFile: fields.app_llm_key_file,
      appSidecarScript: fields.app_sidecar_script,
      appSearchPort: fields.app_search_port,
      appSearchService: fields.app_search_service,
      manifest,
      root,
    };
  }
  return null;
}

/** Every pack on disk, first root wins on a name clash. */
export function discoverPacks(repoRoot: string): Pack[] {
  const seen = new Map<string, Pack>();
  for (const root of packRoots(repoRoot)) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name.startsWith('__')) continue;
      const dir = join(root, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (seen.has(name)) continue;             // earlier root wins
      const pack = readPack(dir, name, root);
      if (pack) seen.set(name, pack);
    }
  }
  return [...seen.values()];
}

/** A pack is usable only if it can actually change how the shell behaves. */
export function isUsable(p: Pack): boolean {
  return Boolean(p.systemPrompt && p.systemPrompt.trim().length > 0);
}

export function findPack(repoRoot: string, name: string): Pack | undefined {
  const want = name.toLowerCase();
  return discoverPacks(repoRoot).find(p => p.name.toLowerCase() === want);
}

/**
 * Should a bare argument be treated as "launch this pack"?
 *
 * `awsh gobbonet` must launch the pack, while `awsh what is gobbonet` must stay
 * an ordinary question. The discriminator is deliberately strict — ONE argument,
 * no spaces, and an EXACT match against a pack that is actually usable — because
 * the cost is asymmetric: mistaking a question for a pack launch drops the user
 * into a session they did not ask for and silently discards what they typed,
 * whereas mistaking a pack name for a question just answers it.
 */
/** Did the user ask for the pack's FULL app rather than the shell? */
export function wantsApp(args: string[]): boolean {
  return args.includes('--app');
}

/** Did the user ask to SET the app's password? Returns the new one, or null. */
export function wantsSetPassword(args: string[]): string | null {
  const i = args.indexOf('--set-password');
  if (i < 0) return null;
  const next = args[i + 1];
  // A value may follow, or the caller is asked for one interactively. An empty
  // string is a REQUEST to prompt, never a password.
  return next && !next.startsWith('--') ? next : '';
}

export function looksLikePackLaunch(args: string[]): string | null {
  // `--app` selects the app half of the SAME launch, so strip it before
  // deciding. Without this `awsh gobbonet --app` is two tokens, fails the
  // one-bare-word rule, and falls through to being asked as a question.
  args = args.filter((a) => a !== '--app');
  // `--set-password [value]` is a mode of the same launch; strip both.
  const sp = args.indexOf('--set-password');
  if (sp >= 0) args = args.filter((_, n) => n !== sp && n !== sp + 1 || args[sp + 1]?.startsWith('--'));
  if (args.length !== 1) return null;
  const a = args[0];
  if (!a || a.startsWith('-') || /\s/.test(a)) return null;
  if (!/^[a-z][a-z0-9._-]*$/i.test(a)) return null;
  return a;
}

/** `--self-test` — every claim above, driven by fixtures rather than the disk. */
export function selfTest(): string[] {
  const f: string[] = [];

  const y = parseManifest([
    'app_name: GobboNet Shell',
    'identity: gobbo',
    'system_prompt: |',
    '  Line one.',
    '',
    '  Line two.',
    'other: value',
  ].join('\n'));
  if (y.app_name !== 'GobboNet Shell') f.push('app_name not parsed');
  if (y.identity !== 'gobbo') f.push('identity not parsed');
  if (!y.system_prompt?.includes('Line one.')) f.push('block scalar lost its first line');
  if (!y.system_prompt?.includes('Line two.')) f.push('block scalar stopped at a blank line');
  if (y.system_prompt?.includes('other: value')) f.push('block scalar swallowed the NEXT key');

  // A pack with no prompt cannot change behaviour, so it must not read as usable.
  if (isUsable({ name: 'x', manifest: 'm', root: 'r' })) f.push('a promptless pack must be unusable');
  if (!isUsable({ name: 'x', manifest: 'm', root: 'r', systemPrompt: 'hi' })) {
    f.push('a pack WITH a prompt must be usable');
  }

  // The launch discriminator, both directions — the asymmetric-cost rule above.
  if (looksLikePackLaunch(['gobbonet']) !== 'gobbonet') f.push('bare name must launch');
  if (looksLikePackLaunch(['what', 'is', 'gobbonet'])) f.push('a question must NOT launch');
  if (looksLikePackLaunch(['what is gobbonet'])) f.push('a quoted question must NOT launch');
  if (looksLikePackLaunch(['--help'])) f.push('a flag must NOT launch');
  if (looksLikePackLaunch([])) f.push('no args must NOT launch');

  return f;
}
