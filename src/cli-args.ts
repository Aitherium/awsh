/**
 * cli-args.ts — argv classification for the `aither` front door.
 *
 * Extracted from main.ts so it can be tested without booting the CLI.
 *
 * The defect this exists to prevent: `collectPositional` used to be a loop that
 * `break`s on the first argument starting with '-'. Every documented flag+message
 * form therefore collected ZERO positionals —
 *
 *     aither -e 1 "Reply with exactly: PONG"      → interactive REPL, not an answer
 *     aither --will iris "draft the post"          → interactive REPL
 *     aither -s casual -a demiurge "review this"   → interactive REPL
 *
 * — and the failure is a SILENCE: no error, no usage message, exit code 0 once the
 * user quits. In a script or a CI step it reads as a hang, and the flags were
 * already being parsed correctly a few lines earlier, so every "is the flag
 * handled?" check passed. Same class as the python adk-shell front door, where
 * `aither "question"` died with `No such command`.
 */

/** Flags that ALWAYS consume the next argument as their value. */
const VALUE_FLAGS = new Set([
  '--command', '-c',
  '--forge', '-f',
  '--agent', '-a', '--will',
  '--effort', '-e',
  '--safety', '-s',
  '--image', '-i',
  '--output-format',
  '--inference-mode',
  '--resume', '--session',
  '--key',
]);

/**
 * Flags that consume the next argument ONLY if it is not itself a flag.
 * These mirror the `args[i + 1] && !args[i + 1].startsWith('-')` guards in main.ts —
 * keep the two in step, or a value gets re-read as the one-shot message.
 */
const OPTIONAL_VALUE_FLAGS = new Set([
  '--print', '-p',
  '--gateway',
  '--deepseek',
  '--kimi', '--moonshot',
]);

/**
 * Collect the one-shot message from argv, skipping flags and their values.
 *
 * Returns an empty array when there is no message (→ interactive REPL), which is
 * the ONLY case that should open the REPL.
 */
export function collectPositional(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      // Everything after `--` is message text, so a dash-leading prompt survives.
      // Caveat, deliberately not papered over: main.ts's own flag loop scans the
      // WHOLE argv and does not honour `--`, so a real flag placed after it still
      // takes effect (it just also lands in the message). This makes the message
      // reachable, which it was not; it is not a full POSIX `--`.
      positional.push(...args.slice(i + 1));
      break;
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;  // skip the value
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(arg)) {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith('-')) continue;  // boolean flag (or unknown) — never message text
    positional.push(arg);
  }
  return positional;
}
