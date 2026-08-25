/**
 * `aither awrun …` — job/run-queue control from the shell, over the SAME
 * harness daemon `aither harness` already uses.
 *
 * awrun itself (AitherOS/packages/awrun) is a local, filesystem-backed
 * priority queue for agentic runs and ad-hoc CI/AWS-runner-pool builds — it
 * is not a networked service. Routing it through the harness daemon (rather
 * than shelling `awrun` directly from this Node process) is what makes it
 * reachable the SAME way a dev sandbox is: from your own machine over
 * loopback, or from anywhere through AITHER_HARNESS_URL and the tunnel —
 * one client, one auth story, no separate install/auth path for the queue.
 *
 * Reuses harness-client's daemonUrl/daemonToken/api rather than a second
 * copy of the same daemon-auth resolution — see the comment there.
 */

import { api, daemonUrl } from './harness-client.js';

function usage(): void {
  console.log(`aither awrun — job/run-queue control (agentic runs, ad-hoc CI, AWS runner pool)

  aither awrun queue [--kind ci|agent|comet-deploy] [--all]
                                             list runs, highest priority first
  aither awrun submit --kind ci --workflow deploy.yml [--ref develop]
                       [--field k=v ...] [--priority N] [--path p ...]
  aither awrun submit --kind agent --task "..." [--agent atlas] [--priority N]
                       [--path p ...]      files this run touches (lease-aware)
  aither awrun status <run-id>
  aither awrun bump <run-id> --priority N       re-steer while it's in flight
  aither awrun cancel <run-id>

Runs through the harness daemon (same one 'aither harness' uses), so this
works from a remote/tunneled shell exactly like a local one.`);
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** Collects every `--field k=v` pair into an object, for the CI `inputs` map. */
function fields(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--field' && args[i + 1]) {
      const [k, ...rest] = args[i + 1].split('=');
      if (k) out[k] = rest.join('=');
    }
  }
  return out;
}

/**
 * Collects every repeatable `--path` flag — the files this run will touch.
 * The dispatcher skips claiming a run whose paths collide with another
 * actor's live awgit lease, rather than colliding with it; without this
 * the daemon route accepted `paths` but nothing on this client could ever
 * send one.
 */
function paths(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}

function printRun(r: any): void {
  const line = `${(r.id || '').padEnd(14)} ${(r.kind || '').padEnd(6)} pri=${String(r.priority ?? 0).padEnd(3)} ${(r.status || '').padEnd(10)}`;
  const label =
    r.spec?.workflow || r.spec?.task || r.spec?.service_name || '';
  console.log(label ? `${line} ${label}` : line);
}

/** Returns a process exit code. Never throws — the caller is a CLI entrypoint. */
export async function runAwrunCommand(args: string[]): Promise<number> {
  const sub = (args[0] || '').toLowerCase();
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    return 0;
  }
  try {
    switch (sub) {
      case 'queue': {
        const kind = flag(args, 'kind');
        const includeClosed = hasFlag(args, 'all');
        const qs = new URLSearchParams();
        if (kind) qs.set('kind', kind);
        if (includeClosed) qs.set('include_closed', 'true');
        const r = await api<{ runs: any[] }>(`/awrun/queue?${qs.toString()}`);
        if (!r.runs.length) {
          console.log('No runs queued.');
          return 0;
        }
        for (const run of r.runs) printRun(run);
        return 0;
      }
      case 'submit': {
        const kind = flag(args, 'kind');
        if (!kind) {
          console.error('usage: aither awrun submit --kind ci|agent|comet-deploy ...');
          return 2;
        }
        const priorityRaw = flag(args, 'priority', '0');
        const body: Record<string, unknown> = {
          kind,
          priority: Number(priorityRaw) || 0,
          task: flag(args, 'task'),
          agent: flag(args, 'agent'),
          workflow: flag(args, 'workflow'),
          ref: flag(args, 'ref'),
          service_name: flag(args, 'service'),
          target: flag(args, 'target'),
          inputs: fields(args),
          paths: paths(args),
        };
        const created = await api<Record<string, any>>('/awrun/submit', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (created.error) {
          console.error(`awrun: ${created.error}`);
          return 1;
        }
        console.log(created.id);
        return 0;
      }
      case 'status': {
        if (!args[1]) {
          console.error('usage: aither awrun status <run-id>');
          return 2;
        }
        const r = await api<Record<string, any>>(`/awrun/status/${args[1]}`);
        if (r.error) {
          console.error(`awrun: ${r.error}`);
          return 1;
        }
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }
      case 'bump': {
        const id = args[1];
        const priority = flag(args, 'priority');
        if (!id || !priority) {
          console.error('usage: aither awrun bump <run-id> --priority N');
          return 2;
        }
        const r = await api<Record<string, any>>(`/awrun/bump/${id}`, {
          method: 'POST',
          body: JSON.stringify({ priority: Number(priority) || 0 }),
        });
        if (r.error) {
          console.error(`awrun: ${r.error}`);
          return 1;
        }
        printRun(r);
        return 0;
      }
      case 'cancel': {
        if (!args[1]) {
          console.error('usage: aither awrun cancel <run-id>');
          return 2;
        }
        const r = await api<Record<string, any>>(`/awrun/cancel/${args[1]}`, {
          method: 'POST',
        });
        if (r.error) {
          console.error(`awrun: ${r.error}`);
          return 1;
        }
        printRun(r);
        return 0;
      }
      default:
        console.error(`unknown subcommand: ${sub}`);
        usage();
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`awrun: ${msg}`);
    if (/fetch failed|ECONNREFUSED|no harness token/i.test(msg)) {
      console.error(`  daemon expected at ${daemonUrl()} — start it with:  adk harness serve`);
    }
    if (/awrun not available/i.test(msg)) {
      console.error('  install the queue extra on the daemon host:  pip install "awdk[queue]"');
    }
    return 1;
  }
}
