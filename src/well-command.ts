/**
 * `aither well` — draw the ambient context: what branch, what changed, who holds files.
 *
 * The well is a background-refreshed snapshot computed continuously by the daemon.
 * Instead of shelling out to git, listing active leases, and guessing at fleet state on
 * every turn, the daemon maintains a single source of truth and serves it instantly.
 */

import { COLORS } from './tui/theme.js';
import { fetchWellSnapshot } from './well-client.js';

function usage(): void {
  console.log(`
${COLORS.accent('aither well')} — ambient context: branch, changes, file locks, agent activity

  aither well                     draw the well for the current directory
  aither well --cwd <path>        a different working directory
  aither well --actor <id>        filter leases/rooms for a specific actor
  aither well --render            output rendered markdown instead of JSON
  aither well --json              explicit JSON output (default when not --render)

The well is served by the harness daemon (adk harness serve), a HOST process — so this
keeps working when the container fleet is down. Contexts computed continuously in the
background and served in O(1) time, never on the critical path.
`);
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function formatRepoInfo(cwd: string, snapshot: any): string[] {
  const repo = snapshot.repo || snapshot.repos?.[cwd];
  if (!repo) {
    return [];
  }

  if (!repo.ok) {
    return [`${COLORS.muted(`[REPO] unavailable: ${repo.reason}`)}`];
  }

  const lines: string[] = [];
  lines.push(
    COLORS.accent(`[REPO]`),
    `  branch: ${COLORS.success(repo.branch || 'unknown')} @ ${COLORS.muted(repo.head || '?')}`,
    `  changes: ${repo.dirty_count || 0} file(s)${repo.dirty_truncated ? ' (sample)' : ''}`,
  );

  if (repo.dirty_sample && repo.dirty_sample.length > 0) {
    lines.push(`    ${repo.dirty_sample.slice(0, 5).join('\n    ')}`);
  }

  if (repo.recent_commits && repo.recent_commits.length > 0) {
    lines.push(`  recent:`);
    repo.recent_commits.slice(0, 4).forEach((commit: string) => {
      lines.push(`    ${COLORS.muted(commit)}`);
    });
  }

  return lines;
}

function formatLeaseInfo(snapshot: any): string[] {
  const leases = snapshot.leases;
  if (!leases) {
    return [];
  }

  if (!leases.ok) {
    return [`${COLORS.muted(`[LEASES] unavailable: ${leases.reason}`)}`];
  }

  const lines: string[] = [];
  const others = snapshot.contended_by_others || leases.leases || [];

  if (others && others.length > 0) {
    lines.push(COLORS.accent(`[LEASES]`), `  ${others.length} file(s) held by other agents:`);
    others.slice(0, 10).forEach((lease: any) => {
      lines.push(`    ${lease.target} — held by ${COLORS.warn(lease.actor)}`);
    });
  } else {
    lines.push(`${COLORS.success('[LEASES]')} no files held by other agents`);
  }

  return lines;
}

function formatRoomInfo(snapshot: any): string[] {
  const rooms = snapshot.rooms || [];
  if (rooms.length === 0) {
    return [];
  }

  const lines: string[] = [COLORS.accent(`[ROOMS]`)];
  rooms.slice(0, 3).forEach((room: any) => {
    const pillars = room.pillars || {};
    const busy = Object.entries(pillars)
      .filter(([_, count]) => (count as number) > 0)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    lines.push(`  ${room.id}: seq ${room.last_seq}${busy ? ` — ${busy}` : ' — quiet'}`);
  });

  return lines;
}

function formatWellMetadata(snapshot: any): string[] {
  const tier = snapshot.tier || 'unknown';
  const age = snapshot.age_seconds ?? 0;
  const sources = snapshot.sources || {};
  const sourceStr = Object.entries(sources)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');

  return [
    ``,
    COLORS.muted(
      `well tier ${tier} · age ${age.toFixed(1)}s · sources ${sourceStr}`,
    ),
  ];
}

export async function runWellCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }

  const cwd = flag(args, '--cwd', process.cwd());
  const actor = flag(args, '--actor', '');
  const render = hasFlag(args, '--render');
  const json = hasFlag(args, '--json') || !render;

  try {
    const snapshot = await fetchWellSnapshot(cwd, actor, render);

    if (!snapshot.ready) {
      console.error(
        COLORS.error(`well not ready: ${snapshot.reason || 'unknown reason'}`),
      );
      return 1;
    }

    if (json) {
      // JSON output — pretty-printed for readability
      console.log(JSON.stringify(snapshot, null, 2));
    } else if (snapshot.rendered) {
      // Markdown output
      console.log(snapshot.rendered);
    } else {
      // Fallback: build it from the structured data
      const lines: string[] = [];

      lines.push(COLORS.accent(`AitherShell ContextWell`));
      lines.push(`tier ${snapshot.tier || 'unknown'}`);
      lines.push('');

      lines.push(...formatRepoInfo(cwd, snapshot));
      lines.push(...formatLeaseInfo(snapshot));
      lines.push(...formatRoomInfo(snapshot));
      lines.push(...formatWellMetadata(snapshot));

      console.log(lines.filter((l) => l !== '').join('\n'));
    }

    return snapshot.ready ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(COLORS.error(`well error: ${msg}`));
    return 1;
  }
}
