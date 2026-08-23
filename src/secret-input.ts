/**
 * Reading a secret without printing it, and keeping it out of history.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Reported live 2026-08-22, setting a GobboNet app password from awsh:
 *
 *     / /password
 *     /password <new-password>   at least 4 characters
 *
 * The help does not merely ALLOW the password on the command line, it
 * INSTRUCTS it. Follow that instruction and the secret is echoed to the
 * terminal, left in scrollback, and -- the part nobody sees --
 * `saveHistory(config.historyFile, input)` runs at the top of `processLine`,
 * so it is APPENDED TO A FILE ON DISK in plaintext, where it stays after the
 * terminal is closed and gets re-read into the next session's history.
 *
 * Both halves live here on purpose. There were already two `saveHistory`
 * implementations (`repl.ts` and `tui/repl-tui.ts`) and one hidden-input
 * reader hidden inside a closure in `commands.ts`, reachable by nothing else.
 * A redaction rule applied to one lane and not the other is not a fix; it is a
 * leak that now looks handled. Same for a second, subtly different, copy of a
 * raw-mode reader.
 */

/**
 * Prompt for a secret with the characters suppressed.
 *
 * Extracted verbatim from the `/login` path in `commands.ts`, which had the
 * only correct implementation in the tree and kept it as a local closure.
 *
 * Returns '' on Ctrl+C, which every caller must treat as "cancelled" rather
 * than as an empty password -- an empty string that reached a hashing routine
 * would set a password of nothing and report success.
 */
export function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve(buf);
      } else if (c === '\x03') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve('');
      } else if (c === '\x7f' || c === '\b') {
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else if (c.charCodeAt(0) >= 32) {
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Commands whose ARGUMENT is a credential.
 *
 * Deliberately keyed on the command, not on the look of the value. A rule that
 * tried to recognise "this looks like a password" would either miss `hunter2`
 * or redact half the transcript, and a history filter that fires on ordinary
 * lines gets turned off -- the same way an over-eager gate gets bypassed
 * rather than satisfied.
 */
const SECRET_COMMANDS = new Set(['password', 'passwd', 'set-password']);

/**
 * Does this input line carry a secret that must never be written to history?
 *
 * TRUE only when an argument is actually present: a bare `/password` is the
 * safe interactive form and is worth keeping in history, because a user
 * pressing Up to re-run it is exactly the behaviour we want to encourage.
 */
export function isSecretBearing(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  const m = /^\/?([A-Za-z][\w-]*)\s+(.+)$/.exec(s);
  if (m && SECRET_COMMANDS.has(m[1].toLowerCase()) && m[2].trim()) return true;
  // Inline credential FLAGS, whatever command they are attached to. `--token`
  // and friends turn up on many commands, and each one is the same disclosure.
  return /(^|\s)--(password|token|api-?key|secret)(=|\s)\S/i.test(s);
}

/**
 * What to write to the history file instead.
 *
 * The command is KEPT and only the value is dropped, so the history still
 * shows what the user did. Replacing the whole line with nothing makes a
 * session's history silently disagree with what happened, which is its own
 * small lie.
 */
export function redactForHistory(line: string): string {
  const s = line.trim();
  const m = /^(\/?[A-Za-z][\w-]*)\s+(.+)$/.exec(s);
  if (m && SECRET_COMMANDS.has(m[1].replace(/^\//, '').toLowerCase())) {
    return `${m[1]} ***`;
  }
  return s.replace(
    /(^|\s)(--(?:password|token|api-?key|secret))(?:=|\s)(\S+)/gi,
    (_all, pre, flag) => `${pre}${flag}=***`,
  );
}
