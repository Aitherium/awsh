/**
 * `aither solve …` / `/solve …` — run the general reasoning loop (adk.reasoning.solve)
 * from awsh.
 *
 * A THIN shell-out to `python -m adk.cli solve …`, cloned from claude-command.ts: the
 * adk CLI owns environment and model construction (`--env`, `--tier`, `--backend`),
 * budgets, events and the exit code, and a second implementation here would drift.
 * Flags are the ones the design names for `adk solve` (awdk/docs/reasoning-loop-
 * design.md §4); anything this parser does not know is forwarded verbatim and
 * argparse is the authority on it.
 *
 * Exit codes are the child's: 0 won, 1 ran and did not win, 2 could not run. When
 * adk itself is not importable by the chosen interpreter this exits 2 with the
 * install line, never a bare traceback. Not `/arc`: that name belongs to ArcPlugin,
 * which steers the fleet's solver.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { COLORS } from './tui/theme.js';
import { pythonExecutable } from './claude-command.js';

export const SOLVE_ENVS = ['toy', 'arc'] as const;
export const SOLVE_MISSING_EXIT = 2;
export const ADK_INSTALL_LINE = "pip install 'aither-adk[reason]'   (add the arc extra for --env arc)";

/** Flags that take NO value when forwarded to `adk solve`. */
const BOOLEAN_FLAGS = new Set(['json', 'steer-stdin']);
/** Numeric flags validated here, before anything is spawned. */
const NUMERIC_FLAGS = new Set(['max-calls', 'max-actions', 'wall-s', 'max-tokens']);

export interface SolveArgs {
  env: string;
  game: string;
  /** Every `--flag [value]`, in order, forwarded verbatim. */
  flags: string[];
  help: boolean;
}

/**
 * Parse `aither solve [toy|arc] [game] [--flag value …]`. Pure. The first positional is
 * the env, the second the game; `--env` / `--game` are accepted too.
 */
export function parseSolveArgs(argv: string[]): SolveArgs {
  const out: SolveArgs = { env: '', game: '', flags: [], help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h' || (i === 0 && a === 'help')) { out.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined;
    if (value === undefined && !BOOLEAN_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
    }
    if (name === 'env' && value !== undefined) { out.env = value; continue; }
    if (name === 'game' && value !== undefined) { out.game = value; continue; }
    out.flags.push(`--${name}`);
    if (value !== undefined) out.flags.push(value);
  }
  if (!out.env && positional.length) out.env = positional.shift() as string;
  if (!out.game && positional.length) out.game = positional.shift() as string;
  if (!out.env) out.env = 'toy';
  return out;
}

/** Returns an error line, or '' when the args are fine. */
export function validateSolveArgs(p: SolveArgs): string {
  if (!(SOLVE_ENVS as readonly string[]).includes(p.env)) {
    return `env must be one of ${SOLVE_ENVS.join(', ')} (got ${JSON.stringify(p.env)})`;
  }
  for (let i = 0; i < p.flags.length; i++) {
    const name = p.flags[i].slice(2);
    if (!NUMERIC_FLAGS.has(name)) continue;
    const v = p.flags[i + 1];
    if (v === undefined || v.startsWith('--') || !(Number(v) > 0)) {
      return `--${name} must be a positive number (got ${JSON.stringify(v ?? '')})`;
    }
  }
  return '';
}

/** The exact argv handed to the interpreter. */
export function buildSolveArgv(p: SolveArgs): string[] {
  const argv = ['-m', 'adk.cli', 'solve', '--env', p.env];
  if (p.game) argv.push('--game', p.game);
  argv.push(...p.flags);
  return argv;
}

export function solveUsage(): string {
  return `
${COLORS.accent('aither solve')} — run the reasoning loop (adk solve) from this terminal

  aither solve                               toy environment, CLI default limits
  aither solve arc ls20                      an ARC-AGI-3 game (needs the arc extra)
  aither solve toy --max-calls 10 --wall-s 120
  aither solve arc ls20 --tier reasoning     or --backend <preset> [--model M]
  aither solve … --json                      print the result as one JSON object

Other flags (--max-actions, --max-tokens, --env-dir, --run-dir, --learn-scope,
--events jsonl|pretty|none, --steer-stdin) go to \`python -m adk.cli solve\` verbatim;
its --help is the authority. Exit: 0 won, 1 ran and did not win, 2 could not run.
Set AITHER_PYTHON to choose the interpreter.
`;
}

export interface SolveDeps {
  spawn?: typeof nodeSpawn;
  /** Returns true when `import adk` works for `py`. */
  probeAdk?: (py: string) => boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

function defaultProbeAdk(py: string): boolean {
  const r = spawnSync(py, ['-c', 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("adk") else 3)'],
    { stdio: 'ignore', timeout: 30_000 });
  return !r.error && r.status === 0;
}

export async function runSolveCommand(argv: string[], deps: SolveDeps = {}): Promise<number> {
  const log = deps.log || ((line: string) => console.error(line));
  const parsed = parseSolveArgs(argv);
  if (parsed.help) { console.log(solveUsage()); return 0; }
  const bad = validateSolveArgs(parsed);
  if (bad) { log(COLORS.error(`  solve: ${bad}`)); return 2; }

  const py = pythonExecutable(deps.env || process.env);
  const probe = deps.probeAdk || defaultProbeAdk;
  if (!probe(py)) {
    log(COLORS.error(`  solve: adk is not importable by ${py}.`));
    log(COLORS.muted(`  install it with: ${ADK_INSTALL_LINE}   (or set AITHER_PYTHON)`));
    return SOLVE_MISSING_EXIT;
  }

  const childArgv = buildSolveArgv(parsed);
  log(COLORS.muted(`  → ${py} ${childArgv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`));
  const spawn = deps.spawn || nodeSpawn;
  return new Promise<number>((resolve) => {
    const child = spawn(py, childArgv, { stdio: 'inherit', env: deps.env || process.env });
    child.on('error', (err: NodeJS.ErrnoException) => {
      log(COLORS.error(err.code === 'ENOENT'
        ? `  solve: cannot find ${py} on PATH — set AITHER_PYTHON to your interpreter.`
        : `  solve: failed to start ${py}: ${err.message}`));
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      if (signal) { log(COLORS.muted(`  solve: exited on ${signal}`)); resolve(1); return; }
      resolve(code ?? 1);
    });
  });
}
