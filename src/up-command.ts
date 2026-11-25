/**
 * `awsh up` & `awsh antigravity` — 2.0 platform bridge paired with `awdk 4.0.0`.
 *
 * `awsh up` brings up the local harness daemons (`hookd`, `awsh` :8362, `aw-hub`),
 * checks composed bricks, auto-wires Antigravity & Claude Code, AND reports
 * awsh terminal avatar & graphics readiness.
 *
 * `awsh antigravity` exposes Antigravity setup, doctor, live session listing,
 * spawning, and steering directly from the terminal.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { detectGraphicsProtocol, listAvailableAvatars } from './tui/terminal-graphics.js';

export interface AdkSpawnResult {
  ran: boolean;
  code: number;
}

function findLocalAwdkRoot(): string | null {
  const candidates = [
    process.env.AITHEROS_ROOT ? join(process.env.AITHEROS_ROOT, 'awdk') : '',
    join(process.cwd(), 'awdk'),
    // From .PRODUCTS/.AITHERSHELL/cli/dist/up-command.js -> monorepo root / awdk
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'awdk'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'adk', 'cli.py'))) return c;
  }
  return null;
}

/** Run `adk <args>` via installed `adk` binary or python3.11/python3/python `-m adk.cli`. */
export function runAdkCli(adkArgs: string[]): AdkSpawnResult {
  const localAwdk = findLocalAwdkRoot();
  const envWithLocal: NodeJS.ProcessEnv = localAwdk
    ? { ...process.env, PYTHONPATH: process.env.PYTHONPATH ? `${localAwdk}:${process.env.PYTHONPATH}` : localAwdk }
    : process.env;

  const candidates: [string, string[], NodeJS.ProcessEnv][] = process.platform === 'win32'
    ? [
        ...(localAwdk ? [['python', ['-m', 'adk.cli', ...adkArgs], envWithLocal] as [string, string[], NodeJS.ProcessEnv]] : []),
        ['adk.exe', adkArgs, process.env],
        ['adk', adkArgs, process.env],
        ['python', ['-m', 'adk.cli', ...adkArgs], envWithLocal],
      ]
    : [
        ...(localAwdk ? [['python3.11', ['-m', 'adk.cli', ...adkArgs], envWithLocal] as [string, string[], NodeJS.ProcessEnv]] : []),
        ['adk', adkArgs, process.env],
        ['python3.11', ['-m', 'adk.cli', ...adkArgs], envWithLocal],
        ['python3', ['-m', 'adk.cli', ...adkArgs], envWithLocal],
        ['python', ['-m', 'adk.cli', ...adkArgs], envWithLocal],
      ];

  for (const [cmd, cmdArgs, env] of candidates) {
    const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env });
    if (!res.error) {
      return { ran: true, code: res.status ?? 0 };
    }
  }
  return { ran: false, code: 1 };
}

/** `awsh up [--status|--down|--dry-run|--no-daemons|--json]` */
export function runUpCommand(args: string[]): number {
  const json = args.includes('--json');
  const res = runAdkCli(['harness', 'up', ...args]);
  if (!res.ran) {
    console.error(chalk.yellow('  `awsh up` needs awdk 4.0+ (`adk harness up`). Install with:'));
    console.error(chalk.cyan('    pip install -U awdk'));
    return 1;
  }
  if (!json && !args.includes('--down') && !args.includes('--help') && !args.includes('-h')) {
    const det = detectGraphicsProtocol();
    const avatars = listAvailableAvatars();
    console.log(
      chalk.dim('  awsh 2.0 · ') +
      chalk.cyan(`avatar=${avatars.length ? avatars.join(',') : 'none'}`) +
      chalk.dim(` · graphics=${det.protocol}`),
    );
  }
  return res.code;
}

/** `awsh antigravity [setup|doctor|sessions|spawn|steer|help]` */
export async function runAntigravityCommand(args: string[]): Promise<number> {
  const sub = (args[0] || 'doctor').toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log([
      chalk.bold('awsh antigravity') + ' — 2-way Google Antigravity + Aither harness bridge',
      '',
      '  awsh antigravity setup [--scope both|global|workspace]   install plugin, hooks, MCP & rules',
      '  awsh antigravity doctor [--self-test] [--json]           verify Antigravity ↔ awdk/awsh wiring',
      '  awsh antigravity sessions                                list live Antigravity sessions via daemon',
      '  awsh antigravity spawn "<prompt>" [--cwd .] [--title T]  start a managed Antigravity session',
      '  awsh antigravity steer <target> "<message>"              steer an active Antigravity session',
    ].join('\n'));
    return 0;
  }

  if (sub === 'setup' || sub === 'doctor') {
    const res = runAdkCli(['antigravity', ...args]);
    if (!res.ran) {
      console.error(chalk.yellow('  `awsh antigravity` needs awdk 4.0+. Install with: pip install -U awdk'));
      return 1;
    }
    return res.code;
  }

  const { runHarnessCommand } = await import('./harness-client.js');
  if (sub === 'sessions' || sub === 'list' || sub === 'ls') {
    return runHarnessCommand(['list']);
  }
  if (sub === 'spawn' || sub === 'new') {
    const rest = args.slice(1);
    const hasHarnessFlag = rest.includes('--harness');
    const promptWords: string[] = [];
    const flags: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith('--')) {
        flags.push(rest[i]);
        if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags.push(rest[++i]);
      } else {
        promptWords.push(rest[i]);
      }
    }
    const newArgs = ['new', ...(hasHarnessFlag ? [] : ['--harness', 'antigravity']), ...flags];
    const code = await runHarnessCommand(newArgs);
    if (code === 0 && promptWords.length) {
      console.log(chalk.dim(`  tip: pass the session id above to: awsh harness send <id> "${promptWords.join(' ')}"`));
    }
    return code;
  }
  if (sub === 'steer' || sub === 'tell') {
    return runHarnessCommand(['tell', ...args.slice(1)]);
  }

  const res = runAdkCli(['antigravity', ...args]);
  if (!res.ran) {
    console.error(chalk.yellow('  `awsh antigravity` needs awdk 4.0+. Install with: pip install -U awdk'));
    return 1;
  }
  return res.code;
}
