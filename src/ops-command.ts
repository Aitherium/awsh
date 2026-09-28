/**
 * `aither ops …` / `/ops …` / `/backups …` — the platform control plane from the CLI.
 *
 * One Genesis API (`/platform/ops/v1`, AitherOS/config/platform_ops.yaml) behind
 * every surface. The verb list is NOT hard-coded: it comes from GET /catalog, so a
 * new op in the registry is a new CLI verb with no CLI release.
 *
 *   aither ops                                   list nouns and verbs (the catalog)
 *   aither ops <noun> state                      read, executed inline, with its proof
 *   aither ops <noun> <verb> [k=v…]              DRY RUN (default): the plan, nothing changes
 *   aither ops <noun> <verb> [k=v…] --apply      start the run (guarded ops wait for a card)
 *            [--agent genesis]                   hand it to an agent (parent + child run)
 *            [--watch]                           follow it to a terminal state
 *   aither ops runs [noun]                       recent runs
 *   aither ops show <run_id>                     one run, with proof checks
 *   aither ops approve|reject <run_id>           a HUMAN answers the approval card
 *   aither ops cancel <run_id>
 *
 * Every call goes through GenesisClient.requestDetailed, which preserves the
 * server's error (401/403/409/422) instead of collapsing it to "no data".
 */

import type { GenesisClient } from './client.js';
import { COLORS } from './tui/theme.js';

const BASE = '/platform/ops/v1';
const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);

export interface OpsArgs {
  noun: string;
  verb: string;
  params: Record<string, string>;
  positional: string[];
  apply: boolean;
  watch: boolean;
  json: boolean;
  agent: string;
  help: boolean;
}

/** Pure argv parser (shared with test/ops-args.test.ts). `k=v` tokens are params. */
export function parseOpsArgs(argv: string[]): OpsArgs {
  const out: OpsArgs = {
    noun: '', verb: '', params: {}, positional: [], apply: false, watch: false,
    json: false, agent: '', help: false,
  };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply' || a === '--yes') out.apply = true;
    else if (a === '--watch' || a === '-w') out.watch = true;
    else if (a === '--json') out.json = true;
    else if (a === '--agent' || a === '--delegate') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.agent = next.toLowerCase(); i++; }
    } else if (a.startsWith('--agent=')) out.agent = a.slice(8).toLowerCase();
    else if (!a.startsWith('--') && a.includes('=') && words.length >= 2) {
      const idx = a.indexOf('=');
      out.params[a.slice(0, idx)] = a.slice(idx + 1);
    } else if (!a.startsWith('--')) words.push(a);
  }
  out.noun = (words[0] || '').toLowerCase();
  out.verb = (words[1] || '').toLowerCase();
  out.positional = words.slice(2);
  return out;
}

function isErr(v: any): v is { error: string; status: number } {
  return !!v && typeof v === 'object' && typeof v.error === 'string' && !('run' in v);
}

function fail(label: string, r: { error: string; status: number }): number {
  const code = r.status ?? 0;
  const why = code === 0 ? 'cannot reach Genesis'
    : code === 401 || code === 403 ? `not authorized (${code})`
    : `HTTP ${code}`;
  console.error(COLORS.error(`  ops ${label}: ${why} — ${r.error}`));
  return 1;
}

function stateColor(state: string): string {
  if (state === 'succeeded') return COLORS.success(state);
  if (state === 'failed' || state === 'blocked') return COLORS.error(state);
  if (state === 'awaiting_approval') return COLORS.warn(state);
  return COLORS.accent(state);
}

function ts(epoch?: number | null): string {
  return epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-';
}

export function renderRun(run: any): string {
  const lines: string[] = [];
  const actor = run.actor || {};
  lines.push(`  ${COLORS.accent(run.id)}  ${run.op}  ${stateColor(run.state)}`);
  lines.push(COLORS.muted(`    actor ${actor.kind}:${actor.id} via ${actor.via}`
    + (run.on_behalf_of ? `  on behalf of ${run.on_behalf_of}` : '')
    + (run.parent_run_id ? `  parent ${run.parent_run_id}` : '')
    + (run.delegate_to ? `  delegated to ${run.delegate_to}` : '')));
  lines.push(COLORS.muted(`    created ${ts(run.created_at)}  finished ${ts(run.finished_at)}`));
  const checks: any[] = run.proof?.checks || [];
  if (checks.length) {
    lines.push(`    proof: ${run.proof.passed ? COLORS.success('PASSED') : COLORS.error('FAILED')}`);
    for (const c of checks) {
      lines.push(`      ${c.ok ? COLORS.success('ok  ') : COLORS.error('FAIL')} ${c.name}`
        + (c.detail && !c.ok ? COLORS.muted(`  ${c.detail}`) : ''));
    }
  }
  if (run.error) lines.push(COLORS.error(`    error: ${run.error}`));
  if (run.state === 'awaiting_approval') {
    lines.push(COLORS.warn(`    waiting for a human: aither ops approve ${run.id}  (or the ActionHub card)`));
  }
  return lines.join('\n');
}

async function catalog(client: GenesisClient): Promise<any> {
  return client.requestDetailed('GET', `${BASE}/catalog`, undefined, 15000);
}

function usage(cat?: any): void {
  console.log(`
${COLORS.accent('aither ops')} — the platform control plane (dry run by default)

  aither ops <noun> <verb> [k=v…] [--apply] [--agent genesis] [--watch] [--json]
  aither ops runs [noun] · show <run_id> · approve|reject <run_id> · cancel <run_id>
  /backups <verb> …  is  aither ops backups <verb> …
`);
  const ops: any[] = cat?.ops || [];
  if (ops.length) {
    console.log('  Available (from GET /platform/ops/v1/catalog):');
    for (const o of ops) {
      const params = Object.keys(o.params || {}).map((k) => `${k}=…`).join(' ');
      const flag = o.approval === 'card' ? COLORS.warn(' [approval card]') : '';
      console.log(`    ${o.noun} ${o.verb} ${params}`.padEnd(48)
        + COLORS.muted(`${o.risk}${''}`) + flag + COLORS.muted(`  ${o.summary || ''}`));
    }
    console.log();
  }
}

async function watchRun(client: GenesisClient, runId: string, json: boolean): Promise<any> {
  let last = '';
  const deadline = Date.now() + 30 * 60 * 1000;
  let run: any = null;
  while (Date.now() < deadline) {
    const r = await client.requestDetailed('GET', `${BASE}/runs/${runId}`, undefined, 15000);
    if (isErr(r)) { fail('watch', r); return null; }
    run = r.run;
    if (run.state !== last) {
      last = run.state;
      if (!json) console.log(`  ${ts(Date.now() / 1000)}  ${runId}  ${stateColor(run.state)}`);
    }
    if (TERMINAL.has(run.state) || run.state === 'awaiting_approval') break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (run?.delegate_to && !run.parent_run_id) {
    const kids = await client.requestDetailed('GET', `${BASE}/runs?parent_run_id=${runId}`,
      undefined, 15000);
    if (!isErr(kids)) for (const k of kids.runs || []) console.log(renderRun(k));
  }
  return run;
}

async function runAction(client: GenesisClient, a: OpsArgs): Promise<number> {
  const cat = await catalog(client);
  if (isErr(cat)) return fail('catalog', cat);
  const op = (cat.ops || []).find((o: any) => o.noun === a.noun && o.verb === a.verb);
  if (!op) {
    console.error(COLORS.warn(`  unknown op: ${a.noun} ${a.verb}`));
    usage(cat);
    return 2;
  }
  if (op.kind === 'read' && op.verb === 'state') {
    const r = await client.requestDetailed('GET', `${BASE}/${a.noun}/state`, undefined, 120000);
    if (isErr(r)) return fail(`${a.noun} state`, r);
    if (a.json) console.log(JSON.stringify(r, null, 2));
    else console.log('\n' + renderRun(r.run) + '\n');
    return r.run?.state === 'succeeded' ? 0 : 1;
  }
  const body: Record<string, any> = {
    op: op.id, params: a.params, dry_run: !a.apply, via: 'cli',
  };
  if (a.agent) body.delegate_to = a.agent;
  const r = await client.requestDetailed('POST', `${BASE}/runs`, body, 60000);
  if (isErr(r)) return fail(op.id, r);
  if (!a.apply) {
    if (a.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(COLORS.accent(`\n  DRY RUN  ${op.id}`) + COLORS.muted(`  (${op.risk}, scope ${op.scope})`));
    for (const c of r.would?.calls || []) console.log(`    would: ${c}`);
    if (r.would?.writes) console.log(`    writes: ${r.would.writes}`);
    if (r.approval_required) console.log(COLORS.warn('    needs a human approval card before it runs'));
    if (r.delegate_to) console.log(`    delegated to: ${r.delegate_to}`);
    console.log(COLORS.muted(`\n  re-run with --apply to start it\n`));
    return 0;
  }
  let run = r.run;
  if (a.json && !a.watch) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log('\n' + renderRun(run));
  if (a.watch) {
    run = (await watchRun(client, run.id, a.json)) || run;
    if (a.json) console.log(JSON.stringify({ run }, null, 2));
    else console.log('\n' + renderRun(run) + '\n');
  }
  if (run.state === 'failed' || run.state === 'blocked') return 1;
  return 0;
}

async function runAdmin(client: GenesisClient, a: OpsArgs): Promise<number | null> {
  const id = a.verb;
  switch (a.noun) {
    case 'runs': {
      const q = a.verb ? `?noun=${encodeURIComponent(a.verb)}&limit=25` : '?limit=25';
      const r = await client.requestDetailed('GET', `${BASE}/runs${q}`, undefined, 15000);
      if (isErr(r)) return fail('runs', r);
      if (a.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      const runs: any[] = r.runs || [];
      if (!runs.length) console.log(COLORS.muted('  no runs yet'));
      for (const run of runs) {
        const actor = run.actor || {};
        console.log(`  ${run.id}  ${run.op.padEnd(16)} ${stateColor(run.state).padEnd(20)} `
          + COLORS.muted(`${actor.kind}:${actor.id} via ${actor.via}  ${ts(run.created_at)}`));
      }
      return 0;
    }
    case 'show': {
      if (!id) { console.error(COLORS.warn('  usage: aither ops show <run_id>')); return 2; }
      const r = await client.requestDetailed('GET', `${BASE}/runs/${id}`, undefined, 15000);
      if (isErr(r)) return fail('show', r);
      console.log(a.json ? JSON.stringify(r, null, 2) : '\n' + renderRun(r.run) + '\n');
      return 0;
    }
    case 'approve':
    case 'reject': {
      if (!id) { console.error(COLORS.warn(`  usage: aither ops ${a.noun} <run_id>`)); return 2; }
      const r = await client.requestDetailed('POST', `${BASE}/runs/${id}/approve`,
        { decision: a.noun, notes: a.params.notes || '' }, 30000);
      if (isErr(r)) return fail(a.noun, r);
      console.log('\n' + renderRun(r.run) + '\n');
      if (a.watch && a.noun === 'approve') {
        const run = await watchRun(client, id, a.json);
        if (run) console.log('\n' + renderRun(run) + '\n');
        return run?.state === 'succeeded' ? 0 : 1;
      }
      return 0;
    }
    case 'cancel': {
      if (!id) { console.error(COLORS.warn('  usage: aither ops cancel <run_id>')); return 2; }
      const r = await client.requestDetailed('POST', `${BASE}/runs/${id}/cancel`, {}, 30000);
      if (isErr(r)) return fail('cancel', r);
      console.log('\n' + renderRun(r.run) + '\n');
      return 0;
    }
    default:
      return null;
  }
}

/**
 * Entry point for `aither ops …` (main.ts), `/ops …` and `/backups …` (commands.ts).
 * 0 ok · 1 the request or the run failed · 2 usage — never 0 on silence.
 */
export async function runOpsCommand(argv: string[], client: GenesisClient): Promise<number> {
  const a = parseOpsArgs(argv);
  if (a.help || !a.noun) {
    const cat = await catalog(client);
    usage(isErr(cat) ? undefined : cat);
    if (isErr(cat) && !a.help) return fail('catalog', cat);
    return a.help ? 0 : 0;
  }
  const admin = await runAdmin(client, a);
  if (admin !== null) return admin;
  if (!a.verb) {
    const cat = await catalog(client);
    usage(isErr(cat) ? undefined : { ops: (cat.ops || []).filter((o: any) => o.noun === a.noun) });
    return 2;
  }
  return runAction(client, a);
}
