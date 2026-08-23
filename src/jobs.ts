/**
 * Background Job Manager for AitherShell.
 *
 * Allows long-running tasks (forge, swarm, chat with agents) to execute
 * in the background while the REPL remains interactive. Jobs collect their
 * output silently and notify the shell on completion.
 *
 * IMPORTANT: Background jobs NEVER write to stdout/stderr directly.
 * All output is collected into job.output[] and read via /jobs <id>.
 * This prevents background tasks from corrupting the interactive prompt.
 *
 * Also includes server-backed job support (expeditions) that arrive via
 * /chat/session-events SSE. Server jobs have UUID ids; users interact
 * via the first 8 characters (id8).
 */

import chalk from 'chalk';
import type { GenesisClient, SSEEvent, StreamChatOpts } from './client.js';

/** Server-backed expedition (durable job). */
export interface ServerExpedition {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  owner: string;
  created_at: string;
  result_summary?: string;
}

/** Blocking gate in an expedition. */
export interface BlockingGate {
  id: string;
  type: string;
  description: string;
  question?: string;
}

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'chat' | 'forge' | 'swarm' | 'command';

export interface Job {
  id: number;
  kind: JobKind;
  label: string;           // Short human-readable description
  status: JobStatus;
  startedAt: Date;
  finishedAt: Date | null;
  output: string[];         // Captured output lines
  error: string | null;
  abortController: AbortController | null;
}

type NotifyFn = (job: Job) => void;

let nextJobId = 1;
const jobs: Map<number, Job> = new Map();
let onJobDone: NotifyFn | null = null;

/** Register a callback that fires when any background job completes. */
export function setJobNotifier(fn: NotifyFn): void {
  onJobDone = fn;
}

/** Get all jobs (most recent first). */
export function listJobs(): Job[] {
  return [...jobs.values()].reverse();
}

/** Get a single job by ID. */
export function getJob(id: number): Job | undefined {
  return jobs.get(id);
}

/** Get count of currently running jobs. */
export function runningCount(): number {
  let count = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') count++;
  }
  return count;
}

/** Cancel a running job. */
export function cancelJob(id: number): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (job.abortController) {
    job.abortController.abort();
  }
  job.status = 'cancelled';
  job.finishedAt = new Date();
  return true;
}

/** Prune completed/failed/cancelled jobs older than `maxAge` ms (default 30 min). */
export function pruneJobs(maxAge = 30 * 60 * 1000): number {
  const now = Date.now();
  let pruned = 0;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.finishedAt && now - job.finishedAt.getTime() > maxAge) {
      jobs.delete(id);
      pruned++;
    }
  }
  return pruned;
}

/* ── Job creation helpers ──────────────────────────────────── */

function createJob(kind: JobKind, label: string): Job {
  const job: Job = {
    id: nextJobId++,
    kind,
    label,
    status: 'running',
    startedAt: new Date(),
    finishedAt: null,
    output: [],
    error: null,
    abortController: new AbortController(),
  };
  jobs.set(job.id, job);
  return job;
}

function finishJob(job: Job, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
  job.status = status;
  job.finishedAt = new Date();
  job.error = error || null;
  job.abortController = null;
  onJobDone?.(job);
}

/* ── Silent SSE content extractor ─────────────────────────── */

/**
 * Extract the final text content from an SSE event stream without
 * writing ANYTHING to stdout. No spinners, no progress — just data.
 */
function extractContentFromEvent(event: SSEEvent): string | null {
  switch (event.type) {
    case 'token':
      return event.data.t || null;
    case 'message':
    case 'answer':
    case 'final_answer':
      return event.data.response || event.data.answer || event.data.content || null;
    case 'partial':
      return event.data.content || event.data.text || null;
    case 'done':
    case 'complete':
      return event.data.content || null;
    default:
      return null;
  }
}

/**
 * Extract metadata/trace info from SSE events for the job log.
 */
function extractTraceFromEvent(event: SSEEvent): string | null {
  switch (event.type) {
    case 'thinking': {
      const thought = event.data.thought || event.data.content || event.data.phase || '';
      const clean = thought.replace(/<\/?think(?:ing)?>/g, '').trim();
      if (clean.length > 10) return `[think] ${clean.slice(0, 200)}`;
      return null;
    }
    case 'tool_call': {
      const tools = event.data.tools || event.data.tool_calls || [];
      const names = tools.map((t: any) => t.name || t.function?.name || 'tool');
      return names.length ? `[tools] ${names.join(', ')}` : null;
    }
    case 'tool_result': {
      const results = event.data.results || [];
      const summary = results.map((r: any) => {
        const icon = r.success !== false ? '+' : 'x';
        return `${icon}${r.tool || 'tool'}`;
      });
      return summary.length ? `[result] ${summary.join(', ')}` : null;
    }
    case 'plan_ready':
      return event.data.summary ? `[plan] ${event.data.summary}` : null;
    case 'error':
      return `[error] ${event.data.error || 'unknown'}`;
    case 'classify': {
      const intent = event.data.intent?.type || '?';
      const effort = event.data.effort?.level || '?';
      return `[classify] intent=${intent} effort=${effort}`;
    }
    case 'classify_update': {
      const uIntent = event.data.intent?.type || '?';
      const uEffort = event.data.effort?.level || '?';
      const uReason = event.data.reason || 'context';
      return `[classify_update] intent=${uIntent} effort=${uEffort} reason=${uReason}`;
    }
    default:
      return null;
  }
}

/* ── Background chat ───────────────────────────────────────── */

/**
 * Launch a streaming chat in the background.
 * Returns the job immediately; the stream runs asynchronously.
 *
 * Consumes the SSE stream silently — no stdout writes, no spinners.
 * Content and trace info are collected into job.output[].
 */
export function launchChatJob(
  client: GenesisClient,
  message: string,
  opts: StreamChatOpts & { label?: string } = {},
): Job {
  const label = opts.label || `Chat: ${message.slice(0, 50)}${message.length > 50 ? '...' : ''}`;
  const job = createJob('chat', label);

  const run = async () => {
    const contentParts: string[] = [];
    let fullAnswer = '';

    // Each background chat gets its own session ID so concurrent jobs
    // don't clobber each other's context on Genesis.
    const bgSessionId = `${opts.sessionId || 'shell'}-bg-${job.id}-${Date.now().toString(36)}`;

    try {
      const stream = client.streamChat(message, {
        ...opts,
        sessionId: bgSessionId,
        priority: 'background',
        signal: job.abortController!.signal,
      });

      for await (const event of stream) {
        // Collect content tokens
        const content = extractContentFromEvent(event);
        if (content) {
          // Token events are incremental, answer/message events are full text
          if (event.type === 'token') {
            contentParts.push(content);
          } else {
            fullAnswer = content;
          }
        }

        // Collect trace info for the job log
        const trace = extractTraceFromEvent(event);
        if (trace) {
          job.output.push(trace);
        }

        // Extract metadata from done/complete
        if (event.type === 'done' || event.type === 'complete') {
          const meta: string[] = [];
          if (event.data.model || event.data.model_used) meta.push(event.data.model || event.data.model_used);
          if (event.data.duration_ms || event.data.elapsed_ms) {
            meta.push(`${Math.round(event.data.duration_ms || event.data.elapsed_ms)}ms`);
          }
          if (event.data.turns_completed) meta.push(`${event.data.turns_completed} turns`);
          if (meta.length) {
            job.output.push(`[meta] ${meta.join(' | ')}`);
          }
        }
      }

      // Use full answer if available, otherwise join tokens
      const finalContent = fullAnswer || contentParts.join('');
      if (finalContent) {
        job.output.push('---');  // separator between trace and content
        job.output.push(finalContent);
      }
      finishJob(job, 'completed');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const partial = fullAnswer || contentParts.join('');
        if (partial) {
          job.output.push('---');
          job.output.push(partial);
          job.output.push('(cancelled — partial output above)');
        }
        finishJob(job, 'cancelled');
      } else {
        finishJob(job, 'failed', err.message);
      }
    }
  };

  run().catch((err) => {
    finishJob(job, 'failed', err.message);
  });

  return job;
}

/* ── Background forge ──────────────────────────────────────── */

export function launchForgeJob(
  client: GenesisClient,
  task: string,
  opts: { agent?: string; effort?: number } = {},
): Job {
  const label = opts.agent
    ? `Forge @${opts.agent}: ${task.slice(0, 40)}...`
    : `Forge: ${task.slice(0, 50)}...`;
  const job = createJob('forge', label);

  const run = async () => {
    try {
      const result = await client.forgeDispatch(task, opts);
      if (result?.error) {
        job.output.push(result.error);
        finishJob(job, 'failed', result.error);
      } else {
        const output = result?.response || result?.result || result?.output;
        job.output.push(output || JSON.stringify(result, null, 2));
        finishJob(job, 'completed');
      }
    } catch (err: any) {
      finishJob(job, 'failed', err.message);
    }
  };

  run().catch((err) => finishJob(job, 'failed', err.message));
  return job;
}

/* ── Background swarm ──────────────────────────────────────── */

export function launchSwarmJob(
  client: GenesisClient,
  task: string,
  mode = 'llm',
): Job {
  const label = `Swarm (${mode}): ${task.slice(0, 40)}...`;
  const job = createJob('swarm', label);

  const run = async () => {
    try {
      const result = await client.post('/swarm/code/sync', { problem: task, mode });
      if (result?.error) {
        job.output.push(result.error);
        finishJob(job, 'failed', result.error);
      } else {
        const output = result?.result || result?.plan || result?.response;
        job.output.push(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
        finishJob(job, 'completed');
      }
    } catch (err: any) {
      finishJob(job, 'failed', err.message);
    }
  };

  run().catch((err) => finishJob(job, 'failed', err.message));
  return job;
}

/* ── Background command ────────────────────────────────────── */

/**
 * Run an arbitrary async function as a background job.
 * Replaces console.log within the function scope to capture output.
 *
 * WARNING: This uses global console.log replacement, so only ONE
 * command job should run at a time. For concurrent background work,
 * use the specific launchers (chat, forge, swarm) instead.
 */
export function launchCommandJob(
  label: string,
  fn: () => Promise<void>,
): Job {
  const job = createJob('command', label);

  const run = async () => {
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const origWrite = process.stdout.write;

    const capture = (...args: any[]) => {
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      job.output.push(line);
    };

    const captureWrite = (chunk: any): boolean => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      if (text.trim()) job.output.push(text);
      return true;
    };

    // Replace all output channels
    console.log = capture as any;
    console.error = capture as any;
    console.warn = capture as any;
    process.stdout.write = captureWrite as any;

    try {
      await fn();
      finishJob(job, 'completed');
    } catch (err: any) {
      finishJob(job, 'failed', err.message);
    } finally {
      // Always restore — even if the fn throws
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      process.stdout.write = origWrite;
    }
  };

  run().catch((err) => {
    finishJob(job, 'failed', err.message);
  });

  return job;
}

/* ── Server job helpers ────────────────────────────────────── */

/**
 * Resolve an ID or prefix (case-insensitive) against a list of expeditions.
 * Matches IDs that start with the query (first 8 chars is typical).
 * Returns the full ID or null if not found / ambiguous.
 */
export function resolveServerJobId(query: string, expeditions: ServerExpedition[]): string | null {
  if (!query) return null;
  const lower = query.toLowerCase();

  // Exact match
  for (const e of expeditions) {
    if (e.id.toLowerCase() === lower) return e.id;
  }

  // Prefix match (case-insensitive)
  const hits = expeditions.filter(e => e.id.toLowerCase().startsWith(lower));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) return null;  // ambiguous

  return null;
}

/**
 * Format a line for a server job (expedition) in the jobs list.
 * Parallel to formatJobLine for client-local jobs.
 */
export function formatServerJobLine(exp: ServerExpedition): string {
  const statusIcon: Record<string, string> = {
    running: chalk.blue('⏱'),
    completed: chalk.green('✓'),
    failed: chalk.red('✗'),
    paused: chalk.yellow('⏸'),
  };
  const icon = statusIcon[exp.status] || '?';
  const id = chalk.bold(exp.id.slice(0, 8));
  const status = exp.status === 'completed'
    ? chalk.green(exp.status)
    : exp.status === 'failed'
      ? chalk.red(exp.status)
      : exp.status === 'running'
        ? chalk.blue(exp.status)
        : chalk.yellow(exp.status);
  const title = (exp.title || '').slice(0, 40);

  return `  ${icon} ${id} ${status} ${chalk.dim('expedition')} ${title}`;
}

/* ── Formatting helpers ────────────────────────────────────── */

export function formatJobLine(job: Job): string {
  const icons: Record<JobStatus, string> = {
    running: chalk.blue('\u25B6'),
    completed: chalk.green('\u2713'),
    failed: chalk.red('\u2717'),
    cancelled: chalk.yellow('\u2015'),
  };

  const icon = icons[job.status];
  const id = chalk.bold(`#${job.id}`);
  const elapsed = formatElapsed(job);
  const status = job.status === 'running'
    ? chalk.blue(job.status)
    : job.status === 'completed'
      ? chalk.green(job.status)
      : job.status === 'failed'
        ? chalk.red(job.status)
        : chalk.yellow(job.status);

  return `  ${icon} ${id} ${status} ${chalk.dim(elapsed)} ${job.label}`;
}

function formatElapsed(job: Job): string {
  const end = job.finishedAt || new Date();
  const ms = end.getTime() - job.startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatJobOutput(job: Job): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`\n  Job #${job.id}: ${job.label}`));
  lines.push(chalk.dim(`  Status: ${job.status} | Started: ${job.startedAt.toLocaleTimeString()}`));
  if (job.finishedAt) {
    lines.push(chalk.dim(`  Finished: ${job.finishedAt.toLocaleTimeString()} (${formatElapsed(job)})`));
  }
  if (job.error) {
    lines.push(chalk.red(`  Error: ${job.error}`));
  }
  if (job.output.length > 0) {
    lines.push('');
    const outputLines = job.output.join('\n').split('\n');
    for (const line of outputLines) {
      lines.push(`  ${line}`);
    }
  } else if (job.status === 'running') {
    lines.push(chalk.dim('  (no output yet)'));
  }
  lines.push('');
  return lines.join('\n');
}
