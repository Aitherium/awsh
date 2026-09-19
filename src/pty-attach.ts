/**
 * pty-attach — put THIS terminal on a daemon-owned pty session.
 *
 * `aither claude` (no task) spawns Claude Code as a `claude-tty` harness session and
 * attaches here: the real TUI, permission prompts and all, rendered from the daemon's
 * SSE stream; every keystroke forwarded verbatim to POST /sessions/{id}/input. The
 * daemon owns the pty, so a steer addressed to the session (a voice line from the desk,
 * `/tell`, an awsh_say from another agent) lands NOW rather than at the next turn
 * boundary — and closing this terminal does not end the session. Ctrl+] detaches;
 * `aither harness attach --pty <id>` re-attaches.
 *
 * Deliberately a CLIENT of the daemon, exactly like the Veil AitherShell app
 * (`components/os/apps/aithershell.tsx`: xterm `onData` -> /input, ResizeObserver ->
 * /resize, `text.delta` -> the terminal). A pty of awsh's own (node-pty) would make the
 * tab just another discovered session nothing can type into — the exact state this
 * exists to end. The pure helpers are exported for the tests; the I/O lives in attachPty.
 */

import { daemonToken, daemonUrl } from './harness-client.js';

/** Ctrl+] — the detach key, same as telnet's escape. Not Ctrl-C: that must reach Claude. */
export const DETACH_BYTE = 0x1d;

export function isDetachKey(byte: number): boolean {
  return byte === DETACH_BYTE;
}

/** One stdin chunk -> what to forward, and whether the detach key was pressed. */
export function splitKeystrokes(chunk: Buffer): { text: string; detach: boolean } {
  const idx = chunk.indexOf(DETACH_BYTE);
  if (idx < 0) return { text: chunk.toString('utf8'), detach: false };
  return { text: chunk.subarray(0, idx).toString('utf8'), detach: true };
}

/** The daemon's ResizeInput. Defaults to 24x80 when the stream is not a terminal. */
export function resizePayload(rows?: number, cols?: number): { rows: number; cols: number } {
  const r = Number.isInteger(rows) && (rows as number) > 0 ? (rows as number) : 24;
  const c = Number.isInteger(cols) && (cols as number) > 0 ? (cols as number) : 80;
  return { rows: r, cols: c };
}

export interface SseEvent { kind: string; data: any }

/**
 * Incremental SSE parser for the daemon's `event: <kind>\ndata: <json>\n\n` frames.
 * Keeps a carry-over between chunks so a frame split across reads is not lost, and
 * skips `: keepalive` comments. Pure: returns the parsed events and the new carry.
 */
export function parseSse(chunk: string, carry = ''): { events: SseEvent[]; carry: string } {
  const text = carry + chunk;
  const frames = text.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: SseEvent[] = [];
  for (const frame of frames) {
    let kind = '';
    let data = '';
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event: ')) kind = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!kind || !data) continue;
    try { events.push({ kind, data: JSON.parse(data) }); } catch { /* a malformed frame is dropped, not fatal */ }
  }
  return { events, carry: rest };
}

export interface AttachOptions {
  since?: number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetchImpl?: typeof fetch;
}

/**
 * Attach the current terminal to session `id`. Resolves with an exit code:
 * 0 on detach (session still alive) or when the session exits cleanly, the
 * session's exit code otherwise. Never throws for a dead stream — it says so.
 */
export async function attachPty(id: string, opts: AttachOptions = {}): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const doFetch = opts.fetchImpl ?? fetch;
  const token = daemonToken();
  if (!token) {
    stderr.write('no harness token found (set AITHER_HARNESS_TOKEN or start the daemon: adk harness serve)\n');
    return 2;
  }
  const base = daemonUrl();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Size the pty to THIS terminal before the first frame, and again on every resize.
  const resize = async () => {
    try {
      await doFetch(`${base}/sessions/${id}/resize`, {
        method: 'POST', headers,
        body: JSON.stringify(resizePayload(stdout.rows, stdout.columns)),
      });
    } catch { /* a missed resize is cosmetic; the stream decides liveness */ }
  };
  await resize();

  // Keystrokes are forwarded IN ORDER: each POST waits for the previous one, so a
  // fast typist cannot land "ba" for "ab".
  let chain: Promise<unknown> = Promise.resolve();
  const forward = (text: string) => {
    if (!text) return;
    chain = chain.then(() =>
      doFetch(`${base}/sessions/${id}/input`, { method: 'POST', headers, body: JSON.stringify({ text }) })
        .catch(() => { /* the stream reports a dead session; a dropped key is not fatal */ }));
  };

  let detached = false;
  let exitCode = 0;
  const controller = new AbortController();
  const finish = (code: number) => { exitCode = code; controller.abort(); };

  const onData = (chunk: Buffer) => {
    const { text, detach } = splitKeystrokes(chunk);
    forward(text);
    if (detach) { detached = true; finish(0); }
  };
  const onEnd = () => { detached = true; finish(0); }; // piped stdin closed = detach
  const onResize = () => { void resize(); };

  const wasRaw = Boolean((stdin as any).isRaw);
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdout.on('resize', onResize);

  stderr.write(`  attached to ${id} — Ctrl+] detaches (the session keeps running)\n`);
  try {
    const res = await doFetch(`${base}/sessions/${id}/stream?since=${opts.since ?? 0}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      stderr.write(`stream error: HTTP ${res.status}\n`);
      return 1;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let carry = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(decoder.decode(value, { stream: true }), carry);
      carry = parsed.carry;
      for (const ev of parsed.events) {
        if (ev.kind === 'text.delta') stdout.write(String(ev.data?.text ?? ''));
        else if (ev.kind === 'error') stderr.write(`\n! ${ev.data?.text ?? 'error'}\n`);
        else if (ev.kind === 'session.exited') {
          const code = ev.data?.data?.exit_code;
          finish(typeof code === 'number' ? code : 0);
        }
      }
      if (controller.signal.aborted) break;
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`stream error: ${msg}\n`);
      if (/fetch failed|ECONNREFUSED/i.test(msg)) stderr.write(`  daemon expected at ${base} — start it with:  adk harness serve\n`);
      exitCode = 1;
    }
  } finally {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdout.off('resize', onResize);
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    await chain;
    if (detached) stderr.write(`\n  detached — session ${id} is still running; re-attach with: aither harness attach --pty ${id}\n`);
  }
  return exitCode;
}
