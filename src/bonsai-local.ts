/**
 * `aither bonsai` — run Bonsai locally on llama.cpp, from the shell.
 *
 * WHY THIS EXISTS. The whole local-inference chain already existed — weights on
 * weights.aitherium.com, llama.cpp as the runtime, `POST /compute/backends/register` to join
 * the compute fabric — and none of it was reachable from AitherShell. The only way in was a
 * runbook a human read and retyped, which is the shape this repo has a standing rule against:
 * an agent that hands the owner a command has not automated anything.
 *
 * So this DOES the steps rather than printing them: sizes the model to the machine it is on,
 * resumes the download, starts the server, waits until it actually answers, and registers it.
 *
 * Intercepted in main.ts BEFORE backend resolution, for the same reason as `harness`, `room`
 * and `well`: llama.cpp is a HOST process and is reachable when Genesis and the container
 * fleet are not. Making local inference wait on a chat backend would take it away exactly
 * when it is most useful — a dead fleet is the moment you want a model on your own machine.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { COLORS } from './tui/theme.js';

/** Where weights land. Shared with the selfhost-bonsai skill so the two agree. */
export const MODELS_DIR = join(homedir(), '.aither', 'models');
/** llama.cpp's default OpenAI-compatible port; adk discovers a local endpoint here. */
export const DEFAULT_PORT = 8080;
const PID_FILE = join(homedir(), '.aither', 'bonsai-local.pid');
const WEIGHTS_BASE = 'https://weights.aitherium.com';

export interface BonsaiModel {
  id: string;
  file: string;
  /** Real download size in MB — the HF blob sizes the catalogue is built from. */
  sizeMb: number;
  /** Working-set RAM for CPU inference, GB. Weights + KV, no swap. */
  ramGb: number;
  blurb: string;
}

/**
 * The four sizes, in the order a picker should offer them.
 *
 * Sizes are the REAL blob sizes, not estimates — the same numbers the browser catalogue and
 * the weight-lane gate use. Keeping one set of numbers matters: a recommendation computed
 * from a wrong size sends someone into a download their machine cannot hold, and the failure
 * lands minutes later as an OOM rather than as a refusal.
 */
export const BONSAI_MODELS: BonsaiModel[] = [
  { id: 'bonsai-1.7b', file: 'Bonsai-1.7B-Q1_0.gguf', sizeMb: 236, ramGb: 3, blurb: 'minimal resources, dev/test' },
  { id: 'bonsai-4b', file: 'Bonsai-4B-Q1_0.gguf', sizeMb: 545, ramGb: 8, blurb: 'laptop, good latency' },
  { id: 'bonsai-8b', file: 'Bonsai-8B-Q1_0.gguf', sizeMb: 1104, ramGb: 16, blurb: 'desktop, real inference' },
  { id: 'bonsai-27b', file: 'Bonsai-27B-Q1_0.gguf', sizeMb: 3627, ramGb: 32, blurb: 'workstation, reasoning' },
];

export function findModel(id: string): BonsaiModel | undefined {
  const want = id.toLowerCase().replace(/^bonsai[-_]?/, '');
  return BONSAI_MODELS.find(
    (m) => m.id === id.toLowerCase() || m.id.replace(/^bonsai-/, '') === want,
  );
}

/**
 * Largest model whose working set fits in `ramGb`, with headroom.
 *
 * Deliberately conservative (60% of total RAM): the working set is weights + KV cache + the
 * OS + whatever else the machine is doing, and a model that swaps is not slow, it is unusable.
 * Never returns undefined — the 1.7B is the floor, because refusing to recommend anything on
 * a small machine is worse than recommending the one that runs there.
 */
export function recommendModel(ramGb: number): BonsaiModel {
  const budget = ramGb * 0.6;
  const fits = BONSAI_MODELS.filter((m) => m.ramGb <= budget);
  return fits.length > 0 ? fits[fits.length - 1] : BONSAI_MODELS[0];
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function totalRamGb(): number {
  return Math.round(totalmem() / 1024 ** 3);
}

function usage(): void {
  console.log(`
${COLORS.accent('aither bonsai')} — run Bonsai locally on llama.cpp

  aither bonsai                    status: is a local endpoint live, and does the fabric know
  aither bonsai models             the catalogue, and what fits this machine
  aither bonsai start [model]      fetch weights if missing, start llama-server, register
  aither bonsai stop               stop the local server
  aither bonsai register           register an already-running endpoint with the fabric

  --port <n>       serve on a different port (default ${DEFAULT_PORT})
  --gpu-layers <n> offload N layers to the GPU (default 999 = as many as fit)
  --no-register    start the server but do not join the compute fabric
  --json           machine-readable output

llama.cpp is a HOST process, so this keeps working when the container fleet is down —
which is exactly when you want a model on your own machine.
`);
}

function flag(args: string[], name: string, fallback = ''): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

/** Is something answering an OpenAI-compatible endpoint on this port? */
export async function probeLocal(port: number): Promise<{ up: boolean; models: string[] }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { up: false, models: [] };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return { up: true, models: (body.data || []).map((d) => d.id || '').filter(Boolean) };
  } catch {
    return { up: false, models: [] };
  }
}

/**
 * Resume-safe weight download.
 *
 * `weights.aitherium.com` serves HTTP 206 with `Accept-Ranges`, so a half-file on disk is
 * resumed rather than restarted — which matters at 3.6 GB on a home connection, where
 * starting over is the difference between "finishes" and "never finishes".
 */
async function ensureWeights(model: BonsaiModel, json: boolean): Promise<string> {
  mkdirSync(MODELS_DIR, { recursive: true });
  const dest = join(MODELS_DIR, model.file);
  const url = `${WEIGHTS_BASE}/${model.file}`;

  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  if (!head.ok) throw new Error(`weights host returned ${head.status} for ${model.file}`);
  const total = Number(head.headers.get('content-length') || 0);

  const have = existsSync(dest) ? statSync(dest).size : 0;
  if (total > 0 && have === total) {
    if (!json) console.log(`${COLORS.success('[OK]')} weights present (${formatMb(model.sizeMb)})`);
    return dest;
  }
  // A file LARGER than the source is not a resume point, it is a different/corrupt file;
  // resuming from there would append garbage and produce a GGUF that loads and talks nonsense.
  if (have > total && total > 0) {
    unlinkSync(dest);
  }
  const from = have > 0 && have < total ? have : 0;

  if (!json) {
    console.log(
      from > 0
        ? `${COLORS.accent('[..]')} resuming ${model.file} at ${formatMb(Math.round(from / 1024 ** 2))}/${formatMb(model.sizeMb)}`
        : `${COLORS.accent('[..]')} downloading ${model.file} (${formatMb(model.sizeMb)})`,
    );
  }

  const res = await fetch(url, from > 0 ? { headers: { Range: `bytes=${from}-` } } : {});
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  await new Promise<void>((resolve, reject) => {
    // Append on resume, truncate otherwise. Getting this backwards is silent: 'w' on a resume
    // discards the bytes already fetched (slow but correct), while 'a' on a fresh start after
    // a partial file appends a second copy — which yields a file that is the right KIND and
    // the wrong LENGTH, and a GGUF whose header parses.
    const out = createWriteStream(dest, { flags: from > 0 ? 'a' : 'w' });
    const rs = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    rs.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    rs.pipe(out);
  });

  // A truncated GGUF LOADS and produces garbage, so verify the magic before handing it to
  // llama.cpp — a refusal here is far cheaper than a model that talks nonsense.
  const fd = readFileSync(dest, { flag: 'r' }).subarray(0, 4);
  if (fd.toString('ascii') !== 'GGUF') {
    throw new Error(`${model.file} is not a valid GGUF (truncated or corrupt) — delete it and retry`);
  }
  return dest;
}

/** Register the local endpoint with the compute fabric. Non-fatal: the server still runs. */
async function registerBackend(
  genesisUrl: string,
  model: BonsaiModel,
  port: number,
  json: boolean,
): Promise<boolean> {
  try {
    const res = await fetch(`${genesisUrl.replace(/\/+$/, '')}/compute/backends/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `bonsai-local-${model.id}`,
        endpoint_url: `http://127.0.0.1:${port}`,
        backend_type: 'openai_compatible',
        models: [model.id],
        api_key: '',
        max_concurrent: 4,
        cost_per_million_tokens: 0,
        location: 'local',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (!json) console.log(`${COLORS.muted(`[--] fabric registration returned ${res.status} — the server is still serving locally`)}`);
      return false;
    }
    if (!json) console.log(`${COLORS.success('[OK]')} registered with the compute fabric as bonsai-local-${model.id}`);
    return true;
  } catch (e) {
    // Deliberately soft: a local model that works is the point, and the fabric being
    // unreachable is the NORMAL case this command exists for.
    if (!json) console.log(`${COLORS.muted(`[--] fabric unreachable (${(e as Error).message.slice(0, 60)}) — serving locally anyway`)}`);
    return false;
  }
}

async function cmdStatus(port: number, json: boolean): Promise<number> {
  const probe = await probeLocal(port);
  const ram = totalRamGb();
  if (json) {
    console.log(JSON.stringify({ up: probe.up, port, models: probe.models, ramGb: ram }, null, 2));
    return probe.up ? 0 : 1;
  }
  if (!probe.up) {
    console.log(`${COLORS.muted(`[--] no local endpoint on 127.0.0.1:${port}`)}`);
    const rec = recommendModel(ram);
    console.log(`     ${ram} GB RAM detected — ${COLORS.accent(`aither bonsai start ${rec.id}`)} fits (${formatMb(rec.sizeMb)})`);
    return 1;
  }
  console.log(`${COLORS.success('[OK]')} local inference on 127.0.0.1:${port}`);
  for (const m of probe.models) console.log(`     model: ${COLORS.accent(m)}`);
  return 0;
}

function cmdModels(json: boolean): number {
  const ram = totalRamGb();
  const rec = recommendModel(ram);
  if (json) {
    console.log(JSON.stringify({ ramGb: ram, recommended: rec.id, models: BONSAI_MODELS }, null, 2));
    return 0;
  }
  console.log(`\n${COLORS.accent('Bonsai models')} — ${ram} GB RAM detected\n`);
  for (const m of BONSAI_MODELS) {
    const fits = m.ramGb <= ram * 0.6;
    const mark = m.id === rec.id ? COLORS.success(' <- recommended') : '';
    const line = `  ${m.id.padEnd(12)} ${formatMb(m.sizeMb).padStart(8)}  needs ~${m.ramGb} GB  ${m.blurb}`;
    console.log(fits ? line + mark : COLORS.muted(line + '  (too large for this machine)'));
  }
  console.log('');
  return 0;
}

async function cmdStart(args: string[], genesisUrl: string, port: number, json: boolean): Promise<number> {
  const ram = totalRamGb();
  const requested = args.find((a) => !a.startsWith('-') && a !== 'start');
  const model = requested ? findModel(requested) : recommendModel(ram);
  if (!model) {
    console.error(`unknown model '${requested}' — try: ${BONSAI_MODELS.map((m) => m.id).join(', ')}`);
    return 2;
  }

  const existing = await probeLocal(port);
  if (existing.up) {
    console.log(`${COLORS.success('[OK]')} already serving on 127.0.0.1:${port} (${existing.models.join(', ') || 'model unknown'})`);
    return 0;
  }

  // Refuse rather than thrash. A model whose working set exceeds RAM does not run slowly, it
  // swaps until the machine is unusable — and the person who asked for it is then fighting
  // their laptop instead of reading an error.
  if (model.ramGb > ram) {
    console.error(
      `${COLORS.warn('[!!]')} ${model.id} needs ~${model.ramGb} GB and this machine has ${ram} GB.\n` +
        `     ${COLORS.accent(`aither bonsai start ${recommendModel(ram).id}`)} fits.`,
    );
    return 2;
  }

  let weights: string;
  try {
    weights = await ensureWeights(model, json);
  } catch (e) {
    console.error(`${COLORS.warn('[!!]')} ${(e as Error).message}`);
    return 1;
  }

  const bin = process.env.LLAMA_SERVER_BIN || 'llama-server';
  const gpuLayers = flag(args, '--gpu-layers', '999');
  const child = spawn(
    bin,
    ['-m', weights, '--port', String(port), '--host', '127.0.0.1', '-ngl', gpuLayers, '--no-warmup'],
    { detached: true, stdio: 'ignore' },
  );
  // ENOENT arrives ASYNCHRONOUSLY, after spawn() has already returned. Without this flag the
  // wait loop below polls a port nothing will ever listen on for the full 120 s and then
  // blames a timeout — so a missing binary, which is the single most likely failure on a
  // fresh machine, would present as "the model is slow to load".
  let spawnError: string | null = null;
  child.on('error', (err) => { spawnError = (err as NodeJS.ErrnoException).code || err.message; });
  child.unref();
  if (child.pid) {
    mkdirSync(join(homedir(), '.aither'), { recursive: true });
    writeFileSync(PID_FILE, String(child.pid), 'utf8');
  }

  // Wait for it to actually ANSWER, not merely to have been spawned. A pid proves a process
  // exists; it does not prove a model loaded, and reporting success off a pid is how a dead
  // endpoint gets registered into the fabric.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (spawnError) {
      console.error(
        `${COLORS.warn('[!!]')} could not launch '${bin}' (${spawnError}).\n` +
          `     The weights are downloaded and ready at ${MODELS_DIR}.\n` +
          `     Install llama.cpp, or set LLAMA_SERVER_BIN to the llama-server binary.`,
      );
      return 1;
    }
    const p = await probeLocal(port);
    if (p.up) {
      console.log(`${COLORS.success('[OK]')} ${model.id} serving on http://127.0.0.1:${port}`);
      if (!args.includes('--no-register')) await registerBackend(genesisUrl, model, port, json);
      return 0;
    }
  }
  console.error(`${COLORS.warn('[!!]')} llama-server did not answer within 120s — check that '${bin}' is installed`);
  return 1;
}

async function cmdStop(port: number): Promise<number> {
  let pid = 0;
  try {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch { /* no pid file — fall through to the probe below */ }
  if (pid > 0) {
    try {
      process.kill(pid);
      unlinkSync(PID_FILE);
      console.log(`${COLORS.success('[OK]')} stopped local server (pid ${pid})`);
      return 0;
    } catch { /* already gone, or not ours */ }
  }
  const probe = await probeLocal(port);
  if (probe.up) {
    console.log(`${COLORS.muted(`[--] something is serving on ${port} but this shell did not start it — leaving it alone`)}`);
    return 1;
  }
  console.log(`${COLORS.muted('[--] nothing to stop')}`);
  return 0;
}

export async function runBonsaiCommand(args: string[], genesisUrl: string): Promise<number> {
  const json = args.includes('--json');
  const port = Number(flag(args, '--port', String(DEFAULT_PORT)));
  const sub = (args[0] || '').toLowerCase();

  if (sub === '--help' || sub === '-h' || sub === 'help') { usage(); return 0; }
  if (sub === 'models' || sub === 'list') return cmdModels(json);
  if (sub === 'start' || sub === 'serve' || sub === 'up') return cmdStart(args, genesisUrl, port, json);
  if (sub === 'stop' || sub === 'down') return cmdStop(port);
  if (sub === 'register') {
    const probe = await probeLocal(port);
    if (!probe.up) { console.error('no local endpoint to register — start one first'); return 1; }
    const model = findModel(probe.models[0] || '') || recommendModel(totalRamGb());
    return (await registerBackend(genesisUrl, model, port, json)) ? 0 : 1;
  }
  if (!sub || sub.startsWith('-')) return cmdStatus(port, json);

  console.error(`unknown subcommand '${sub}'`);
  usage();
  return 2;
}
