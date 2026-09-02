/**
 * `aither claude <task…>` / `/claude <task…>` — hand a scoped task to a Claude Code
 * subagent through the adk runner daemon.
 *
 * This is the awsh → Claude Code direction of the handoff (the other direction is
 * the `/aither` slash command in `.claude/commands/aither.md`). It is deliberately a
 * THIN shell-out to `python -m adk.cli claude spawn`: the runner owns scope, budget,
 * account selection and the fail-closed Bearer auth, and duplicating any of that
 * here would be a second implementation that drifts. The flag names below are the
 * runner's OWN (`adk claude spawn --help`, read 2026-09-02) — `--allow`,
 * `--budget-usd`, `--timeout`, `--goal`. Nothing is invented; the only mapping is
 * the shorter `--budget` → `--budget-usd`.
 *
 * Auth: the runner resolves its token as explicit `--token` →
 * AITHER_CLAUDE_RUNNER_TOKEN → AITHER_INTERNAL_SECRET → the persisted token file
 * under ~/.aither/claude-runner. So an unset AITHER_INTERNAL_SECRET is not fatal
 * here — the spawn may still authenticate through the persisted file — but it IS
 * the usual reason a spawn 401s, and that 401 names nothing. Hence the one-line
 * hint below instead of a silent fall-through.
 */

import { spawn } from 'node:child_process';
import { COLORS } from './tui/theme.js';

export const DEFAULT_ALLOW = 'Read';
export const DEFAULT_BUDGET_USD = '0.25';
export const DEFAULT_TIMEOUT_SEC = '300';

/** Flags that take NO value when passed through to `adk claude spawn`. */
const BOOLEAN_PASSTHROUGH = new Set(['no-wait']);

export interface ClaudeArgs {
  /** The task prompt, joined from every positional token. */
  task: string;
  allow: string;
  budget: string;
  timeout: string;
  goal: string;
  /** Any other `--flag [value]` pairs, forwarded verbatim (argparse validates them). */
  passthrough: string[];
  help: boolean;
}

/**
 * Parse `aither claude …` argv. Pure — no I/O — so it is testable, the same way
 * parseStorageArgs is. Flag rule: `--name value` when the next token is not
 * itself a flag, else a boolean switch. Positional tokens form the task.
 */
export function parseClaudeArgs(argv: string[]): ClaudeArgs {
  const out: ClaudeArgs = {
    task: '',
    allow: DEFAULT_ALLOW,
    budget: DEFAULT_BUDGET_USD,
    timeout: DEFAULT_TIMEOUT_SEC,
    goal: '',
    passthrough: [],
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }

    // `--name=value` and `--name value` both accepted.
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined;
    if (value === undefined && !BOOLEAN_PASSTHROUGH.has(name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
    }

    switch (name) {
      case 'allow':   if (value !== undefined) out.allow = value; break;
      case 'budget':  if (value !== undefined) out.budget = value; break;
      case 'timeout': if (value !== undefined) out.timeout = value; break;
      case 'goal':    if (value !== undefined) out.goal = value; break;
      default:
        out.passthrough.push(`--${name}`);
        if (value !== undefined) out.passthrough.push(value);
    }
  }
  out.task = positional.join(' ').trim();
  return out;
}

/** Build the exact argv handed to `python -m adk.cli claude spawn …`. */
export function buildSpawnArgv(p: ClaudeArgs): string[] {
  const argv = ['-m', 'adk.cli', 'claude', 'spawn'];
  if (p.task) argv.push('--task', p.task);
  argv.push('--allow', p.allow);
  argv.push('--budget-usd', p.budget);
  argv.push('--timeout', p.timeout);
  if (p.goal) argv.push('--goal', p.goal);
  argv.push(...p.passthrough);
  return argv;
}

/** Validate the numeric flags before anything is spawned; returns an error line or ''. */
export function validateClaudeArgs(p: ClaudeArgs): string {
  if (!Number.isFinite(Number(p.budget)) || Number(p.budget) < 0) {
    return `--budget must be a non-negative number in USD (got ${JSON.stringify(p.budget)})`;
  }
  const t = Number(p.timeout);
  if (!Number.isInteger(t) || t <= 0) {
    return `--timeout must be a positive whole number of seconds (got ${JSON.stringify(p.timeout)})`;
  }
  if (!p.allow.trim()) return '--allow must name at least one tool (e.g. Read or Read,Grep)';
  return '';
}

/**
 * The one-line credential hint. Printed to stderr when AITHER_INTERNAL_SECRET is
 * unset so a later 401 from the runner has a named cause. Never the value itself.
 */
export function internalSecretHint(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AITHER_INTERNAL_SECRET || env.AITHER_CLAUDE_RUNNER_TOKEN) return '';
  return 'AITHER_INTERNAL_SECRET is not set in this shell — the runner may 401. '
    + 'Source it the way the runner does: C:\\Users\\wzns\\.aither\\bin\\claude-runner-wrapper.ps1 '
    + 'reads it from .DEPLOYMENT/.env (falls back to ~/.aither/claude-runner/token if present).';
}

/** Python launcher: AITHER_PYTHON wins, else `python` on Windows, `python3` elsewhere. */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.AITHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export function claudeUsage(): string {
  return `
${COLORS.accent('aither claude')} — hand a task to a scoped Claude Code subagent (adk runner)

  aither claude <task…>                       spawn a run and stream its result here
  aither claude --allow Read,Grep <task…>     tools the subagent may use (default: ${DEFAULT_ALLOW})
  aither claude --budget 0.50 <task…>         max spend in USD (default: ${DEFAULT_BUDGET_USD})
  aither claude --timeout 600 <task…>         run timeout in seconds (default: ${DEFAULT_TIMEOUT_SEC})
  aither claude --goal <id> <task…>           attribute the run to a goal id

Any other --flag is forwarded verbatim to \`adk claude spawn\` (e.g. --model haiku,
--cwd <dir>, --deny <tools>, --no-wait, --task-file <path>) — \`python -m adk.cli
claude spawn --help\` is the authority on those.

This shells out to \`python -m adk.cli claude spawn\`, streams the child's stdout and
stderr, and exits with its code. The runner daemon (adk claude serve, :8365) must be up.
The runner authenticates with AITHER_INTERNAL_SECRET (or its persisted token file); when
that variable is unset you get a one-line hint naming the source rather than a bare 401.
`;
}

export async function runClaudeCommand(argv: string[]): Promise<number> {
  const parsed = parseClaudeArgs(argv);
  if (parsed.help) { console.log(claudeUsage()); return 0; }

  // A task is required unless the caller is forwarding --task-file to the runner.
  const hasTaskFile = parsed.passthrough.includes('--task-file');
  if (!parsed.task && !hasTaskFile) {
    console.error(COLORS.error('  claude: a task is required — aither claude "<what to do>"'));
    console.log(claudeUsage());
    return 2;
  }
  const bad = validateClaudeArgs(parsed);
  if (bad) {
    console.error(COLORS.error(`  claude: ${bad}`));
    return 2;
  }

  const hint = internalSecretHint();
  if (hint) console.error(COLORS.muted(`  ${hint}`));

  const py = pythonExecutable();
  const childArgv = buildSpawnArgv(parsed);
  console.error(COLORS.muted(`  → ${py} ${childArgv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`));

  return new Promise<number>((resolve) => {
    const child = spawn(py, childArgv, { stdio: 'inherit', env: process.env });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(COLORS.error(`  claude: cannot find ${py} on PATH — set AITHER_PYTHON to your interpreter.`));
      } else {
        console.error(COLORS.error(`  claude: failed to start ${py}: ${err.message}`));
      }
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(COLORS.muted(`  claude: runner exited on ${signal}`));
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
