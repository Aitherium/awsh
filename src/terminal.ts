/**
 * terminal.ts — remote PTY client for `aither connect` / `adk shell`.
 *
 * Opens a raw interactive terminal from ANY PC, over HTTPS, into the owner's
 * prod/dev environment via the tunnel's existing PTY gateway:
 *
 *     wss://<tunnel>/tunnel/ssh?token=<jwt>[&container=<dev-workspace>]
 *
 * The PTY lives SERVER-side (docker exec + `script`, tmux-backed and
 * reconnectable) — so the client needs NO node-pty. It just puts the local TTY
 * in raw mode and shuttles JSON frames:
 *   client → server: {"type":"input","data":<raw>} , {"type":"resize",cols,rows} , {"type":"pong"}
 *   server → client: {"type":"output","data":<ansi>} , {"type":"connected",...} , {"type":"ping"}
 *
 * Close codes from the server: 4001 auth failed, 4003 terminal capability
 * denied, 4004 container not running.
 *
 * Transport is the platform-global WebSocket (Node 22+/bun), matching relay.ts.
 * Token goes in the query string, so no custom WS headers are required.
 */
import chalk from 'chalk';
import { getActiveToken } from './auth.js';

export interface TerminalOptions {
  /** Dev-workspace container to attach to; omitted → shell in the tunnel container. */
  container?: string;
  /** Tunnel host. Default: env AITHER_TUNNEL_URL host, else tunnel.aitherium.com. */
  host?: string;
  /** Pre-obtained JWT; falls back to getActiveToken(). */
  token?: string;
}

function resolveHost(explicit?: string): string {
  if (explicit) return explicit.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  const env = process.env.AITHER_TUNNEL_URL;
  if (env) return env.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return 'tunnel.aitherium.com';
}

function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

/**
 * Connect an interactive terminal. Resolves when the session ends (clean exit,
 * server close, or Ctrl-D). Rejects only on a fatal setup error.
 */
export async function connectTerminal(opts: TerminalOptions = {}): Promise<number> {
  const token = opts.token ?? getActiveToken();
  if (!token) {
    console.error(chalk.red('  Not authenticated. Run `aither login` first.'));
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(chalk.red('  `connect` needs an interactive terminal (TTY).'));
    return 1;
  }

  const WS: any = (globalThis as any).WebSocket;
  if (!WS) {
    console.error(chalk.red('  WebSocket unavailable — needs Node 22+ or the bun binary.'));
    return 1;
  }

  const host = resolveHost(opts.host);
  const params = new URLSearchParams({ token });
  if (opts.container) params.set('container', opts.container);
  const url = `wss://${host}/tunnel/ssh?${params.toString()}`;

  const target = opts.container ? `workspace ${chalk.cyan(opts.container)}` : `${chalk.cyan(host)}`;
  process.stderr.write(chalk.dim(`  connecting to ${target} …\n`));

  return new Promise<number>((resolve) => {
    let ws: any;
    let rawSet = false;
    let closed = false;
    let exitCode = 0;

    const restore = () => {
      if (rawSet && process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      }
      process.stdin.removeAllListeners('data');
      process.stdout.removeAllListeners('resize');
      try { process.stdin.pause(); } catch { /* ignore */ }
    };

    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      restore();
      try { ws?.close(); } catch { /* ignore */ }
      resolve(code);
    };

    const sendResize = () => {
      if (!ws || ws.readyState !== 1) return;
      const { cols, rows } = termSize();
      try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* ignore */ }
    };

    try {
      ws = new WS(url);
    } catch (e: any) {
      console.error(chalk.red(`  connect failed: ${e?.message ?? e}`));
      return resolve(1);
    }

    ws.addEventListener('open', () => {
      // Raw mode: deliver keystrokes (incl. Ctrl-C, arrows, Esc) straight to the
      // remote PTY instead of the local shell interpreting them.
      try { process.stdin.setRawMode(true); rawSet = true; } catch { /* ignore */ }
      process.stdin.resume();
      sendResize(); // tell the server our real size up front

      process.stdin.on('data', (chunk: Buffer) => {
        if (ws.readyState !== 1) return;
        // Ctrl-Q (0x11) is our local "detach" escape — leave the session running.
        if (chunk.length === 1 && chunk[0] === 0x11) { finish(0); return; }
        // UTF-8 both ways to match the server (raw.encode() / chunk.decode() are UTF-8).
        // 'binary'/latin1 would corrupt multibyte chars (box-drawing in htop/vim, accents).
        try { ws.send(JSON.stringify({ type: 'input', data: chunk.toString('utf8') })); }
        catch { /* dropped; close handler will fire */ }
      });

      process.stdout.on('resize', sendResize);
      process.stderr.write(chalk.dim('  connected — Ctrl-Q to detach\r\n'));
    });

    ws.addEventListener('message', (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      switch (msg.type) {
        case 'output':
          process.stdout.write(Buffer.from(String(msg.data ?? ''), 'utf8'));
          break;
        case 'ping':
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
          break;
        case 'connected':
        default:
          break;
      }
    });

    ws.addEventListener('close', (ev: any) => {
      const code = ev?.code;
      restore();
      if (!closed) {
        if (code === 4003) {
          console.error(chalk.red('\n  Terminal access denied (your role lacks the `terminal` capability).'));
          exitCode = 13;
        } else if (code === 4001) {
          console.error(chalk.red('\n  Authentication failed — run `aither login` and retry.'));
          exitCode = 1;
        } else if (code === 4004) {
          console.error(chalk.red('\n  Container not running.'));
          exitCode = 1;
        } else {
          process.stderr.write(chalk.dim('\n  session closed\n'));
        }
      }
      finish(exitCode);
    });

    ws.addEventListener('error', () => {
      // A close event follows with the real code; just note it once.
      if (!closed) process.stderr.write(chalk.dim(''));
    });
  });
}
