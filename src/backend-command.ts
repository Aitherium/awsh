/**
 * `aither backend <list|use|status>` / `/backend <list|use|status>` — manage which
 * LLM backend drives a Claude Code session launched from this shell.
 *
 * This exists because there was NO command anywhere for it: switching Claude Code's
 * own backend (deepseek/kimi-k3/anthropic) lived only as a hand-run PowerShell script
 * two directories deep in one machine's checkout (tools/claude-backend/claude-backend.ps1),
 * unreachable from awsh, from any agent, and from a stranger's install of this package.
 *
 * SAFETY MODEL — copied from .claude/skills/backend-switching/SKILL.md, which is the
 * canonical doctrine; do not let this drift from it:
 *   - Every override lives ONLY in the env of the child `claude` process spawned below.
 *   - NOTHING is ever written to persistent env (User/Machine), settings.json, or
 *     ~/.claude.json. Exit the child and the override is gone — there is nothing to undo.
 *   - `use` always clears every known var first, then applies exactly one profile's
 *     vars — never a mix of two profiles' leftovers.
 *   - Switching one terminal's backend does NOT touch any other running Claude Code
 *     session; there is deliberately no "apply to all sessions" lever.
 *
 * PROFILE SOURCE — this is a PUBLISHED cross-machine package (npm i -g @aitherium/awsh),
 * so no fleet-specific endpoint, token path, or bridge URL is baked in here (that would
 * be dead on every machine but the one that wrote it, and a disclosure on top of that).
 * Profiles load from AITHER_CLAUDE_BACKEND_PROFILES, else ~/.aither/claude-backend/
 * profiles.json (same JSON shape the AitherOS monorepo's own copy uses — see
 * tools/claude-backend/profiles.json there for a worked example incl. deepseek/kimi-k3).
 * With no file present, only the built-in `anthropic` (no vars — your saved login)
 * profile exists, so `backend list` never comes back empty on a stranger's machine.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { COLORS } from './tui/theme.js';

export interface BackendProfile {
  comment?: string;
  /** Name of an env var already set in this shell (or the parent's env) holding the key. */
  token_env?: string;
  /** Path to a file holding the raw key (trimmed on read). */
  token_file?: string;
  /** Env vars to apply verbatim. `null`/absent means "no overrides" (the anthropic default). */
  vars?: Record<string, string> | null;
}

export type BackendProfiles = Record<string, BackendProfile>;

/**
 * Every var any backend integration on Claude Code is known to touch. Grow this list
 * if a provider's docs introduce a new one — `status` and `use` both key off it, and a
 * var missing from here is a var `use` cannot clear before applying the next profile.
 */
export const ALL_VARS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'MAX_THINKING_TOKENS', 'MAX_MCP_OUTPUT_TOKENS',
  // Tool search is OFF by default behind a custom ANTHROPIC_BASE_URL; every non-default
  // profile must set it explicitly or the session loses MCP tools.
  'ENABLE_TOOL_SEARCH',
] as const;

const BUILTIN_PROFILES: BackendProfiles = {
  anthropic: {
    comment: 'Default. No vars at all — claude uses your saved login. 1M context on Max.',
    vars: null,
  },
};

export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.AITHER_CLAUDE_BACKEND_PROFILES || '').trim();
  if (explicit) return explicit;
  return join(homedir(), '.aither', 'claude-backend', 'profiles.json');
}

/** Load profiles from disk, merged onto the built-in default so `anthropic` always exists. */
export function loadProfiles(path: string = profilesPath()): BackendProfiles {
  if (!existsSync(path)) return { ...BUILTIN_PROFILES };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const { _README, ...profiles } = raw; // the monorepo copy carries a _README array; ignore it
    return { ...BUILTIN_PROFILES, ...profiles };
  } catch {
    // Unreadable file: don't silently pretend it's empty — surface it, but still
    // return a usable default so `list`/`use anthropic` keep working.
    console.error(COLORS.warn(`  backend: ${path} exists but is not valid JSON — ignoring it.`));
    return { ...BUILTIN_PROFILES };
  }
}

/** Resolve a profile's auth token from token_env or token_file. Never logs the value. */
export function resolveToken(p: BackendProfile, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (p.token_env) {
    const t = env[p.token_env];
    if (!t) {
      throw new Error(
        `profile needs token '${p.token_env}' — not set in this shell's environment. `
        + `Set it before running 'use': $env:${p.token_env}="…" (PowerShell) or export ${p.token_env}=… (sh).`,
      );
    }
    return t;
  }
  if (p.token_file) {
    if (!existsSync(p.token_file)) throw new Error(`token_file not found: ${p.token_file}`);
    return readFileSync(p.token_file, 'utf-8').trim();
  }
  return undefined;
}

export interface BackendArgs {
  sub: 'list' | 'use' | 'status' | 'help';
  profileName: string;
  help: boolean;
}

export function parseBackendArgs(argv: string[]): BackendArgs {
  const sub = (argv[0] || 'help').toLowerCase();
  const validSub = sub === 'list' || sub === 'use' || sub === 'status' ? sub : 'help';
  return {
    sub: validSub as BackendArgs['sub'],
    profileName: argv[1] || '',
    help: argv.includes('--help') || argv.includes('-h') || validSub === 'help',
  };
}

export function backendUsage(): string {
  return `
${COLORS.accent('aither backend')} — switch which LLM backend drives THIS Claude Code session

  aither backend list                    show configured profiles
  aither backend use <profile>            launch claude on that profile (session-only)
  aither backend status                   audit this shell's env for stray overrides

Session-scoped only: overrides live in the child \`claude\` process's env and vanish
when it exits. Nothing is ever written to disk, settings.json, or ~/.claude.json.

Profiles load from ${COLORS.muted('$AITHER_CLAUDE_BACKEND_PROFILES')} or
${COLORS.muted('~/.aither/claude-backend/profiles.json')} (same JSON shape as the
AitherOS monorepo's tools/claude-backend/profiles.json). With none present, only the
built-in 'anthropic' (no overrides) profile exists.
`;
}

function printList(profiles: BackendProfiles): void {
  console.log('Profiles (edit the profiles.json path above to add more):');
  for (const [name, p] of Object.entries(profiles)) {
    const tag = name === 'anthropic' ? COLORS.muted(' (default backend)') : '';
    console.log(`  ${name}${tag}`);
    if (p.comment) console.log(COLORS.muted(`    ${p.comment}`));
  }
}

function printStatus(env: NodeJS.ProcessEnv): void {
  console.log('=== Backend override audit (this shell only) ===');
  let dirty = false;
  for (const v of ALL_VARS) {
    const val = env[v];
    if (val) {
      dirty = true;
      const shown = v.includes('TOKEN') || v.includes('KEY') ? '<set>' : val;
      console.log(`  ${v} = ${shown}`);
    }
  }
  console.log('');
  if (dirty) {
    console.log(COLORS.warn('RESULT: this shell has backend overrides set. They die with it — '
      + 'no action needed unless a NEW shell also shows them (that would mean something '
      + 'persisted them, which this tool never does).'));
  } else {
    console.log(COLORS.success('RESULT: clean — no backend overrides in this shell\'s environment.'));
  }
  console.log(COLORS.muted(
    '\nNote: this checks THIS process\'s env only. It cannot see persistent User/Machine\n'
    + 'env vars, settings.json, or a saved model default — those are OS/file-level and\n'
    + 'need a platform-specific audit (the AitherOS monorepo\'s claude-backend.ps1 `status`\n'
    + 'does that on Windows).',
  ));
}

export async function runBackendCommand(argv: string[]): Promise<number> {
  const parsed = parseBackendArgs(argv);
  if (parsed.help) { console.log(backendUsage()); return 0; }

  const path = profilesPath();
  const profiles = loadProfiles(path);

  if (parsed.sub === 'list') { printList(profiles); return 0; }
  if (parsed.sub === 'status') { printStatus(process.env); return 0; }

  // sub === 'use'
  if (!parsed.profileName) {
    console.error(COLORS.error('  backend: use requires a profile name — try: aither backend list'));
    return 2;
  }
  const profile = profiles[parsed.profileName];
  if (!profile) {
    console.error(COLORS.error(`  backend: no profile '${parsed.profileName}'. Try: aither backend list`));
    return 2;
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ALL_VARS) delete childEnv[v];

  if (profile.vars) {
    for (const [k, v] of Object.entries(profile.vars)) {
      if (!(ALL_VARS as readonly string[]).includes(k)) {
        console.error(COLORS.warn(`  backend: profile sets unknown var ${k} — add it to ALL_VARS so status/use can see it.`));
      }
      childEnv[k] = v;
    }
  }

  let token: string | undefined;
  try {
    token = resolveToken(profile, process.env);
  } catch (err) {
    console.error(COLORS.error(`  backend: ${(err as Error).message}`));
    return 2;
  }
  if (token) childEnv.ANTHROPIC_AUTH_TOKEN = token;

  console.error(COLORS.muted(`  → launching claude on profile '${parsed.profileName}' (session-only; exit to fully revert)`));
  if (parsed.profileName !== 'anthropic') {
    console.error(COLORS.muted('  → do NOT run /model and save it as default while on a non-default profile'));
    console.error(COLORS.muted('  → do NOT let any agent/task edit settings.json or persist ANTHROPIC_* vars'));
  }

  return new Promise<number>((resolve) => {
    // shell:true on win32 — a global npm install of `claude` resolves to a .cmd shim
    // there, which a plain (non-shell) spawn cannot exec directly.
    const child = spawn('claude', [], {
      stdio: 'inherit',
      env: childEnv,
      shell: process.platform === 'win32',
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(COLORS.error('  backend: cannot find `claude` on PATH.'));
      } else {
        console.error(COLORS.error(`  backend: failed to start claude: ${err.message}`));
      }
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      console.error(COLORS.muted('  ← claude exited; this shell\'s overrides were only ever in the child — nothing to clean up.'));
      if (signal) { resolve(1); return; }
      resolve(code ?? 1);
    });
  });
}
