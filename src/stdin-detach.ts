/**
 * stdin-detach — run an inquirer prompt (or any handler that reads stdin
 * directly) with the OUTER readline fully detached from stdin.
 *
 * Why this exists: `rl.pause()` does NOT stop readline's own internal
 * 'data'/'keypress' listeners from intercepting and buffering keystrokes, so
 * they run CONCURRENTLY with the inquirer prompt's listeners on the same
 * stream. After the prompt resolves, that desync left the REPL needing a dead
 * first Enter before typed input registered again — the "press Enter twice
 * after a slash command" bug. The command path already did this detach/restore
 * dance inline; the slash-command picker did not. This centralises it so both
 * paths behave identically and the invariant is unit-tested.
 */

/** The subset of `process.stdin` this helper touches (kept minimal for tests). */
export interface DetachableStdin {
  rawListeners(event: string): Array<(...args: unknown[]) => void>;
  removeAllListeners(event: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  resume(): unknown;
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** The subset of the readline interface this helper touches. */
export interface PausableReadline {
  pause(): unknown;
}

/**
 * Detach the outer readline's 'data'/'keypress' listeners, run `fn`, then
 * restore EXACTLY those listeners — even if `fn` throws. Raw mode is turned
 * off before `fn` (inquirer manages its own); the caller restores raw mode via
 * its normal readline-restore path after this returns.
 */
export async function runWithDetachedStdin<T>(
  stdin: DetachableStdin,
  rl: PausableReadline,
  fn: () => Promise<T>,
): Promise<T> {
  rl.pause();
  const dataListeners = stdin.rawListeners('data').slice();
  const keypressListeners = stdin.rawListeners('keypress').slice();
  stdin.removeAllListeners('data');
  stdin.removeAllListeners('keypress');
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(false);
  }
  stdin.resume();
  try {
    return await fn();
  } finally {
    // Drop whatever the prompt attached, then reinstate ours verbatim.
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    for (const listener of dataListeners) stdin.on('data', listener);
    for (const listener of keypressListeners) stdin.on('keypress', listener);
  }
}
