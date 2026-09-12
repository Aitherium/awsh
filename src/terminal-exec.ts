/**
 * terminal-exec.ts — headless one-shot over the tunnel PTY gateway.
 *
 * `aither connect [container] -- <cmd…>` / `aither connect -x "<cmd>"`.
 *
 * Same wire protocol as terminal.ts (wss://<tunnel>/tunnel/ssh, JSON frames),
 * but no TTY, no raw mode: send the command line(s), collect `output` frames,
 * return plain text + an exit code. That is what CI, cron, PowerShell and
 * coding agents (Claude Code, Codex) need — none of them have a TTY, and until
 * now the only way in was to hand-roll a websocket client.
 *
 * Two server modes, decided by whether `container` is set:
 *   - container → tmux-backed bash. We append `echo <marker>$?` to the line and
 *     stop when the marker comes back, so the real exit code is captured.
 *   - no container → the tunnel's restricted allow-listed shell (docker, curl,
 *     cat, grep, …). It runs ONE allow-listed command per input line, rejects
 *     `;`/`&&`, and never reports an exit code. We send each command as its own
 *     line, then `echo <marker>0` (echo is allow-listed) as the end-of-run
 *     signal, and fall back to a quiet-timeout if the marker never arrives.
 */
import { getActiveToken } from './auth.js';

export interface ExecOptions {
  /** Dev-workspace container to exec in; omitted → restricted shell in the tunnel container. */
  container?: string;
  /** Tunnel host. Default: env AITHER_TUNNEL_URL host, else tunnel.aitherium.com. */
  host?: string;
  /** Pre-obtained JWT; falls back to getActiveToken(). */
  token?: string;
  /** Command line(s). Each entry is one input line. */
  commands: string[];
  /** Hard cap for the whole run (ms). Default 120000. */
  timeoutMs?: number;
  /** Stop after this much output silence once something arrived (ms). Default 2500. */
  quietMs?: number;
}

export interface ExecResult {
  /** Remote `$?` in container mode; 0 for a clean restricted-shell run; 1 on auth/transport failure; 124 on timeout. */
  code: number;
  /** All `output` frames, ANSI-stripped, marker lines removed. */
  output: string;
  reason: 'marker' | 'quiet' | 'timeout' | 'closed' | 'error';
}

const EXEC_MARKER = '__AWSH_EXEC_DONE_';

/** Strip ANSI CSI + OSC sequences so headless callers get plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

export function resolveTunnelHost(explicit?: string): string {
  if (explicit) return explicit.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const env = process.env.AITHER_TUNNEL_URL;
  if (env) return env.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return 'tunnel.aitherium.com';
}

/** Server close codes → human text. Shared with the interactive path. */
export function describeCloseCode(code: number | undefined): string | null {
  switch (code) {
    case 4001: return 'Authentication failed — run `aither login` and retry.';
    case 4003: return 'Terminal access denied (your role lacks the `terminal` capability).';
    case 4004: return 'Container not running.';
    default: return null;
  }
}

export async function execRemote(
  opts: ExecOptions,
  sink?: (chunk: string) => void,
): Promise<ExecResult> {
  const token = opts.token ?? getActiveToken();
  if (!token) return { code: 1, output: 'Not authenticated. Run `aither login` first.\n', reason: 'error' };
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) return { code: 1, output: 'WebSocket unavailable — needs Node 22+ or the bun binary.\n', reason: 'error' };

  const host = resolveTunnelHost(opts.host);
  const params = new URLSearchParams({ token });
  if (opts.container) params.set('container', opts.container);
  const url = `wss://${host}/tunnel/ssh?${params.toString()}`;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const quietMs = opts.quietMs ?? 2_500;
  const pty = !!opts.container;
  const marker = `${EXEC_MARKER}${Date.now().toString(36)}_`;
  const markerRe = new RegExp(`${marker}(\\d+)`);

  return new Promise<ExecResult>((resolve) => {
    let ws: any;
    let done = false;
    let buf = '';
    let lastRx = Date.now();
    let quietTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const finish = (code: number, reason: ExecResult['reason']) => {
      if (done) return;
      done = true;
      if (quietTimer) clearInterval(quietTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { ws?.close(); } catch { /* ignore */ }
      const cleaned = stripAnsi(buf)
        .split(/\r?\n/)
        .filter((l) => !l.includes(EXEC_MARKER))
        .join('\n');
      resolve({ code, output: cleaned, reason });
    };

    const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch { /* close handler fires */ } };

    try { ws = new WS(url); }
    catch (e: any) { return resolve({ code: 1, output: String(e?.message ?? e), reason: 'error' }); }

    hardTimer = setTimeout(() => finish(124, 'timeout'), timeoutMs);

    ws.addEventListener('open', () => {
      send({ type: 'resize', cols: 200, rows: 50 });
      if (pty) {
        // `;` so the marker still fires when the command fails.
        send({ type: 'input', data: `${opts.commands.join('; ')}; echo ${marker}$?\n` });
      } else {
        for (const c of opts.commands) send({ type: 'input', data: `${c}\n` });
        send({ type: 'input', data: `echo ${marker}0\n` });
      }
      // The server may close (4001/4003) synchronously while we were sending;
      // never arm the quiet timer after finish() has already run.
      if (done) return;
      quietTimer = setInterval(() => {
        if (buf.length > 0 && Date.now() - lastRx > quietMs) finish(0, 'quiet');
      }, 250);
    });

    ws.addEventListener('message', (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (msg.type === 'ping') { send({ type: 'pong' }); return; }
      if (msg.type === 'output') {
        const text = String(msg.data ?? '');
        buf += text;
        lastRx = Date.now();
        const m = stripAnsi(buf).match(markerRe);
        // Never stream our own marker line to the caller.
        if (sink && !text.includes(EXEC_MARKER)) sink(text);
        if (m) finish(Number(m[1]), 'marker');
        return;
      }
      if (msg.error) {
        buf += `${msg.error}\n`;
        finish(1, 'error');
      }
    });

    ws.addEventListener('close', (ev: any) => {
      if (done) return;
      const text = describeCloseCode(ev?.code);
      if (text) { buf += `${text}\n`; finish(ev.code === 4003 ? 13 : 1, 'error'); }
      else finish(buf.length ? 0 : 1, 'closed');
    });
    ws.addEventListener('error', () => { /* close follows with the real code */ });
  });
}
