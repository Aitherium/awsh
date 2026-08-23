/**
 * `aither room` — watch the AitherAeon room: six pillar lanes, every agent surface.
 *
 * Deliberately renders to plain stdout rather than taking over the blessed screen.
 * `aither room --follow` is the thing you leave open in a second terminal while you
 * work, and a full-screen TUI that repaints cannot be scrolled back through or piped
 * into a file. The pure view function (tui/room-view.ts) is shared, so when the room
 * becomes a pane inside the REPL it renders identically.
 */

import { COLORS } from './tui/theme.js';
import { buildRoomPanel } from './tui/room-view.js';
import { fetchRoomSnapshot } from './room-client.js';

function usage(): void {
  console.log(`
${COLORS.accent('aither room')} — the AitherAeon room: six pillars, every agent surface

  aither room                     one snapshot of room "main"
  aither room --room <id>         a different room
  aither room --follow            keep watching (Ctrl+C to stop)
  aither room --interval <sec>    poll interval for --follow (default 2)
  aither room --lane <pillar>     only one lane (intent|context|reasoning|
                                  orchestration|learning|automation)
  aither room --limit <n>         rows per lane (default 4)

The room is served by the harness daemon (adk harness serve), a HOST process — so
this keeps working when the container fleet is down.
`);
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

export async function runRoomCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }

  const room = flag(args, '--room', 'main');
  const lane = flag(args, '--lane', '').toLowerCase();
  const perLane = Number(flag(args, '--limit', '4')) || 4;
  const follow = args.includes('--follow') || args.includes('-f');
  const interval = Math.max(1, Number(flag(args, '--interval', '2')) || 2);
  const width = process.stdout.columns || 100;

  const render = async (): Promise<boolean> => {
    const snapshot = await fetchRoomSnapshot(room);
    let lines = buildRoomPanel(snapshot, width, perLane);

    if (lane) {
      // Keep the header, the requested lane block and the footer. Filtering the
      // RENDERED lines keeps one layout definition rather than a second code path
      // that can drift from the full view.
      const kept: string[] = [];
      let inLane = false;
      for (const line of lines) {
        const bare = line.replace(/\[[0-9;]*m/g, '').trim();
        const isLaneHeader = /^(intent|context|reasoning|orchestration|learning|automation)\s+\d+/.test(bare);
        if (isLaneHeader) inLane = bare.startsWith(lane);
        if (!isLaneHeader && bare.startsWith('·')) inLane = false;
        if (kept.length === 0 || inLane || bare.startsWith('·') || bare.startsWith('AitherAeon')) {
          kept.push(line);
        }
      }
      lines = kept;
    }

    console.log(lines.filter((l) => l !== '').join('\n'));
    return snapshot.ok;
  };

  if (!follow) {
    const ok = await render();
    return ok ? 0 : 1;
  }

  // --follow: a dead daemon must not spin a tight failing loop, but it must also
  // not exit — the daemon may be restarting, and a watcher that quits on the first
  // blip is a watcher nobody trusts. Render, wait, repeat, and let the panel itself
  // say when the room is unreachable.
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    console.clear();
    await render();
    console.log(COLORS.muted(`\n  polling every ${interval}s — Ctrl+C to stop`));
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
  return 0;
}
