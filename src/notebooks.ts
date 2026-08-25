/**
 * Agent Notebook interactive TUI for AitherShell CLI.
 *
 * Provides a proper interactive notebook experience in the terminal:
 *   /nb list           — Browse notebooks with status/effort/tags
 *   /nb open <id>      — Open interactive session (cell-by-cell execution)
 *   /nb run <id>       — Execute entire notebook (streaming output)
 *   /nb plan <prompt>  — Create notebook from natural language
 *   /nb create <name>  — Create empty notebook
 *   /nb templates      — List available templates
 *   /nb sessions       — List active sessions
 *
 * The interactive session (/nb open) renders cells with box-drawing
 * characters, colored output, and supports Shift+Enter / Enter to
 * execute cells one at a time.
 */

import chalk from 'chalk';
import ora from './spinner.js';
import { createInterface } from 'node:readline';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import { formatTable, renderMarkdown } from './renderer.js';

// ── Cell type styling ────────────────────────────────────────────────────────

const CELL_ICONS: Record<string, string> = {
  prompt: '\u25B6',         // play
  tool_call: '\u2692',      // hammer+pick
  agent_delegate: '\u2691', // flag
  service_call: '\u2601',   // cloud
  script: '\u2630',         // trigram
  checkpoint: '\u26A0',     // warning
  context: '\u2139',        // info
  plan: '\u2605',           // star
  note: '\u2709',           // envelope
  result: '\u2713',         // check
  condition: '\u2753',      // question
  parallel_block: '\u2261', // triple bar
  loop: '\u21BB',           // loop arrow
  mcts_branch: '\u2726',    // 4-pointed star
  transform: '\u21C4',      // left-right arrows
};

const CELL_COLORS: Record<string, (s: string) => string> = {
  prompt: chalk.cyan,
  tool_call: chalk.yellow,
  agent_delegate: chalk.magenta,
  service_call: chalk.blue,
  script: chalk.green,
  checkpoint: chalk.red,
  context: chalk.dim,
  plan: chalk.white,
  note: chalk.gray,
  result: chalk.greenBright,
};

const STATUS_BADGES: Record<string, string> = {
  pending: chalk.dim('\u25CB pending'),
  running: chalk.yellow('\u25CF running'),
  completed: chalk.green('\u2713 done'),
  failed: chalk.red('\u2717 failed'),
  skipped: chalk.dim('\u2212 skipped'),
  waiting: chalk.yellow('\u23F3 waiting'),
};

// ── Box drawing helpers ──────────────────────────────────────────────────────

const BOX = {
  tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F',
  h: '\u2500', v: '\u2502', vr: '\u251C', vl: '\u2524',
};

function boxTop(title: string, width: number): string {
  const inner = width - 4;
  const titleStr = ` ${title} `;
  const pad = Math.max(0, inner - titleStr.length);
  return chalk.dim(`${BOX.tl}${BOX.h}`) + chalk.bold(titleStr) + chalk.dim(BOX.h.repeat(pad) + BOX.tr);
}

function boxLine(content: string, width: number): string {
  const stripped = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - 4 - stripped.length);
  return chalk.dim(BOX.v) + ' ' + content + ' '.repeat(pad) + ' ' + chalk.dim(BOX.v);
}

function boxBottom(width: number): string {
  return chalk.dim(`${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`);
}

function boxSeparator(width: number): string {
  return chalk.dim(`${BOX.vr}${BOX.h.repeat(width - 2)}${BOX.vl}`);
}

// ── Cell rendering ───────────────────────────────────────────────────────────

interface CellInfo {
  id: string;
  type: string;
  name: string;
  config: Record<string, any>;
  status?: string;
  output?: string;
  tokens?: number;
  cost?: number;
  duration_ms?: number;
}

function renderCell(cell: CellInfo, index: number, total: number, width: number): string {
  const icon = CELL_ICONS[cell.type] || '\u25A1';
  const colorFn = CELL_COLORS[cell.type] || chalk.white;
  const status = STATUS_BADGES[cell.status || 'pending'] || '';
  const cellNum = `[${index + 1}/${total}]`;

  const lines: string[] = [];
  const title = `${icon} ${colorFn(cell.name || cell.type)} ${chalk.dim(cellNum)} ${status}`;
  lines.push(boxTop(title, width));

  // Cell content preview
  const contentKey = cell.type === 'prompt' ? 'prompt'
    : cell.type === 'tool_call' ? 'tool'
    : cell.type === 'agent_delegate' ? 'agent'
    : cell.type === 'script' ? 'script'
    : cell.type === 'checkpoint' ? 'message'
    : 'prompt';

  const content = cell.config?.[contentKey]
    || cell.config?.prompt
    || cell.config?.description
    || '';

  if (content) {
    const preview = String(content).slice(0, width - 8).split('\n').slice(0, 3);
    for (const line of preview) {
      lines.push(boxLine(chalk.dim(line), width));
    }
    if (String(content).length > width - 8 || String(content).split('\n').length > 3) {
      lines.push(boxLine(chalk.dim('...'), width));
    }
  }

  // Tool-specific info
  if (cell.type === 'tool_call' && cell.config?.tool) {
    lines.push(boxLine(chalk.yellow(`tool: ${cell.config.tool}`), width));
    if (cell.config?.arguments) {
      const args = typeof cell.config.arguments === 'object'
        ? JSON.stringify(cell.config.arguments).slice(0, width - 16)
        : String(cell.config.arguments).slice(0, width - 16);
      lines.push(boxLine(chalk.dim(`args: ${args}`), width));
    }
  }

  if (cell.type === 'agent_delegate' && cell.config?.agent) {
    lines.push(boxLine(chalk.magenta(`agent: ${cell.config.agent}`), width));
  }

  if (cell.type === 'checkpoint') {
    lines.push(boxLine(chalk.red.bold('REQUIRES APPROVAL'), width));
  }

  // Output section (if executed)
  if (cell.output) {
    lines.push(boxSeparator(width));
    lines.push(boxLine(chalk.green.bold('Output:'), width));
    const outputLines = cell.output.split('\n').slice(0, 8);
    for (const line of outputLines) {
      lines.push(boxLine(line.slice(0, width - 6), width));
    }
    if (cell.output.split('\n').length > 8) {
      lines.push(boxLine(chalk.dim(`... ${cell.output.split('\n').length - 8} more lines`), width));
    }
  }

  // Metrics
  if (cell.tokens || cell.cost || cell.duration_ms) {
    const metrics: string[] = [];
    if (cell.tokens) metrics.push(`${cell.tokens} tok`);
    if (cell.cost) metrics.push(`$${cell.cost.toFixed(4)}`);
    if (cell.duration_ms) metrics.push(`${(cell.duration_ms / 1000).toFixed(1)}s`);
    lines.push(boxLine(chalk.dim(metrics.join(' \u2502 ')), width));
  }

  lines.push(boxBottom(width));
  return lines.join('\n');
}

// ── Subcommand handlers ──────────────────────────────────────────────────────

async function nbList(client: GenesisClient, args: string): Promise<void> {
  const spinner = ora('Loading notebooks...').start();
  const data = await client.get('/notebooks/');
  spinner.stop();

  if (!data || !data.notebooks) {
    console.log(chalk.red('  Could not fetch notebooks. Is Genesis running?'));
    return;
  }

  const notebooks: any[] = data.notebooks;
  if (notebooks.length === 0) {
    console.log(chalk.dim('  No notebooks found. Create one with /nb plan <prompt>'));
    return;
  }

  console.log(chalk.bold(`\n  Agent Notebooks (${notebooks.length})\n`));

  const rows = notebooks.slice(0, 30).map((nb: any) => {
    const status = nb.status === 'completed' ? chalk.green('\u2713')
      : nb.status === 'running' ? chalk.yellow('\u25CF')
      : nb.status === 'failed' ? chalk.red('\u2717')
      : chalk.dim('\u25CB');
    const cells = nb.cell_count ?? nb.cells ?? '?';
    const tags = (nb.tags || []).slice(0, 3).map((t: string) => chalk.dim(`#${t}`)).join(' ');
    return [
      `  ${status}`,
      chalk.cyan(nb.id || ''),
      nb.name?.slice(0, 40) || chalk.dim('(untitled)'),
      String(cells),
      tags,
    ];
  });

  console.log(formatTable(['  ', 'ID', 'Name', 'Cells', 'Tags'], rows));
  console.log();
}

async function nbOpen(client: GenesisClient, notebookId: string): Promise<void> {
  if (!notebookId) {
    console.log(chalk.red('  Usage: /nb open <notebook_id>'));
    return;
  }

  // Start interactive session
  const spinner = ora('Starting notebook session...').start();
  const session = await client.post(`/notebooks/${notebookId}/sessions`);
  spinner.stop();

  if (!session || !session.session_id) {
    console.log(chalk.red(`  Failed to start session for ${notebookId}`));
    return;
  }

  const sessionId = session.session_id;
  const cells: CellInfo[] = (session.cells || []).map((c: any) => ({
    id: c.id || c.cell_id,
    type: c.type,
    name: c.name || c.type,
    config: c.config || {},
    status: c.status || 'pending',
  }));

  const width = Math.min(process.stdout.columns || 100, 120);

  // Header
  console.log();
  console.log(chalk.bold.cyan(`  \u2584\u2584 Agent Notebook Session`));
  console.log(chalk.dim(`  Session: ${sessionId}`));
  console.log(chalk.dim(`  Notebook: ${notebookId}`));
  console.log(chalk.dim(`  Cells: ${cells.length}`));
  console.log();

  // Render all cells
  cells.forEach((cell, i) => {
    console.log(renderCell(cell, i, cells.length, width));
    console.log();
  });

  // Interactive loop
  console.log(chalk.bold('  Interactive Session Controls:'));
  console.log(chalk.dim('    enter     \u2500 Execute next pending cell'));
  console.log(chalk.dim('    r <n>     \u2500 Run cell #n'));
  console.log(chalk.dim('    run-all   \u2500 Execute all remaining cells'));
  console.log(chalk.dim('    vars      \u2500 Show session variables'));
  console.log(chalk.dim('    approve   \u2500 Approve current checkpoint'));
  console.log(chalk.dim('    reject    \u2500 Reject current checkpoint'));
  console.log(chalk.dim('    save      \u2500 Save session state'));
  console.log(chalk.dim('    q         \u2500 End session'));
  console.log();

  let currentCell = 0;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('  nb> '),
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim().toLowerCase();

    if (input === 'q' || input === 'quit' || input === 'exit') {
      const spinner = ora('Ending session...').start();
      await client.post(`/notebooks/sessions/${sessionId}/interrupt`);
      spinner.stop();
      console.log(chalk.dim('  Session ended.'));
      rl.close();
      return;
    }

    if (input === '' || input === 'enter') {
      // Execute next pending cell
      const pending = cells.find(c => c.status === 'pending');
      if (!pending) {
        console.log(chalk.dim('  All cells executed.'));
        rl.prompt();
        continue;
      }

      const cellId = pending.id;
      console.log(chalk.yellow(`  Executing: ${pending.name || pending.type}...`));
      const execSpinner = ora('  Running cell...').start();
      const result = await client.post(
        `/notebooks/sessions/${sessionId}/execute/${cellId}`
      );
      execSpinner.stop();

      if (result) {
        pending.status = result.status || 'completed';
        pending.output = result.output || result.content || result.result || '';
        pending.tokens = result.tokens_used || result.tokens || 0;
        pending.cost = result.cost || 0;
        pending.duration_ms = result.duration_ms || 0;

        console.log();
        console.log(renderCell(pending, cells.indexOf(pending), cells.length, width));
        console.log();

        if (pending.status === 'completed') {
          console.log(chalk.green(`  \u2713 Cell completed`));
        } else if (pending.status === 'failed') {
          console.log(chalk.red(`  \u2717 Cell failed`));
        } else if (pending.status === 'waiting') {
          console.log(chalk.yellow(`  \u23F3 Checkpoint — type 'approve' or 'reject'`));
        }
      } else {
        console.log(chalk.red('  Cell execution failed'));
        pending.status = 'failed';
      }

      currentCell++;
    } else if (input.startsWith('r ')) {
      const num = parseInt(input.slice(2)) - 1;
      if (isNaN(num) || num < 0 || num >= cells.length) {
        console.log(chalk.red(`  Invalid cell number. Range: 1-${cells.length}`));
        rl.prompt();
        continue;
      }

      const cell = cells[num];
      console.log(chalk.yellow(`  Executing: ${cell.name || cell.type}...`));
      const execSpinner = ora('  Running cell...').start();
      const result = await client.post(
        `/notebooks/sessions/${sessionId}/execute/${cell.id}`
      );
      execSpinner.stop();

      if (result) {
        cell.status = result.status || 'completed';
        cell.output = result.output || result.content || result.result || '';
        cell.tokens = result.tokens_used || result.tokens || 0;
        cell.cost = result.cost || 0;
        cell.duration_ms = result.duration_ms || 0;

        console.log();
        console.log(renderCell(cell, num, cells.length, width));
        console.log();
      } else {
        console.log(chalk.red('  Cell execution failed'));
      }
    } else if (input === 'run-all') {
      console.log(chalk.yellow('  Running all remaining cells...'));
      const runSpinner = ora('  Executing...').start();
      const result = await client.post(
        `/notebooks/sessions/${sessionId}/run-all`
      );
      runSpinner.stop();

      if (result && result.cells) {
        for (const cellResult of result.cells) {
          const cell = cells.find(c => c.id === cellResult.cell_id);
          if (cell) {
            cell.status = cellResult.status || 'completed';
            cell.output = cellResult.output || cellResult.content || '';
            cell.tokens = cellResult.tokens_used || 0;
            cell.cost = cellResult.cost || 0;
            cell.duration_ms = cellResult.duration_ms || 0;
          }
        }

        console.log();
        cells.forEach((cell, i) => {
          console.log(renderCell(cell, i, cells.length, width));
          console.log();
        });

        const ok = cells.filter(c => c.status === 'completed').length;
        const fail = cells.filter(c => c.status === 'failed').length;
        console.log(chalk.bold(`  Results: ${chalk.green(`${ok} passed`)}  ${fail ? chalk.red(`${fail} failed`) : ''}`));
      } else {
        console.log(chalk.red('  Run-all failed'));
      }
    } else if (input === 'vars') {
      const state = await client.get(`/notebooks/sessions/${sessionId}`);
      if (state?.variables && Object.keys(state.variables).length > 0) {
        console.log(chalk.bold('\n  Session Variables:\n'));
        for (const [key, val] of Object.entries(state.variables)) {
          const valStr = typeof val === 'string' ? val.slice(0, 80) : JSON.stringify(val).slice(0, 80);
          console.log(`  ${chalk.cyan(key)} = ${chalk.dim(valStr)}`);
        }
        console.log();
      } else {
        console.log(chalk.dim('  No variables set.'));
      }
    } else if (input === 'approve' || input === 'reject') {
      const waitingCell = cells.find(c => c.status === 'waiting' || c.type === 'checkpoint');
      if (!waitingCell) {
        console.log(chalk.dim('  No checkpoint waiting for approval.'));
        rl.prompt();
        continue;
      }
      const resolution = input === 'approve' ? 'approved' : 'rejected';
      const result = await client.post(
        `/notebooks/sessions/${sessionId}/gate/${waitingCell.id}`,
        { resolution }
      );
      if (result) {
        waitingCell.status = resolution === 'approved' ? 'completed' : 'skipped';
        console.log(
          resolution === 'approved'
            ? chalk.green(`  \u2713 Checkpoint approved`)
            : chalk.yellow(`  \u2212 Checkpoint rejected`)
        );
      }
    } else if (input === 'save') {
      const result = await client.post(`/notebooks/sessions/${sessionId}/save`);
      console.log(result ? chalk.green('  \u2713 Session saved') : chalk.red('  Save failed'));
    } else if (input === 'status') {
      console.log();
      cells.forEach((cell, i) => {
        const badge = STATUS_BADGES[cell.status || 'pending'] || '';
        const icon = CELL_ICONS[cell.type] || '\u25A1';
        console.log(`  ${chalk.dim(`${i + 1}.`)} ${icon} ${cell.name || cell.type} ${badge}`);
      });
      console.log();
    } else {
      console.log(chalk.dim(`  Unknown command: ${input}. Type 'q' to quit.`));
    }

    rl.prompt();
  }

  rl.close();
}

async function nbRun(client: GenesisClient, notebookId: string): Promise<void> {
  if (!notebookId) {
    console.log(chalk.red('  Usage: /nb run <notebook_id>'));
    return;
  }

  console.log(chalk.bold(`\n  Running notebook ${chalk.cyan(notebookId)}...\n`));
  const spinner = ora('  Executing notebook...').start();

  const result = await client.post(`/notebooks/${notebookId}/execute`);
  spinner.stop();

  if (!result) {
    console.log(chalk.red('  Execution failed. Check Genesis logs.'));
    return;
  }

  const width = Math.min(process.stdout.columns || 100, 120);

  // Show results
  if (result.cells) {
    result.cells.forEach((cell: any, i: number) => {
      const cellInfo: CellInfo = {
        id: cell.cell_id || cell.id,
        type: cell.type || 'unknown',
        name: cell.name || cell.type,
        config: cell.config || {},
        status: cell.status || 'completed',
        output: cell.output || cell.content || '',
        tokens: cell.tokens_used || 0,
        cost: cell.cost || 0,
        duration_ms: cell.duration_ms || 0,
      };
      console.log(renderCell(cellInfo, i, result.cells.length, width));
      console.log();
    });
  }

  // Summary
  const status = result.status || 'unknown';
  const totalTokens = result.total_tokens || 0;
  const totalCost = result.total_cost || 0;
  const duration = result.duration_ms || 0;

  console.log(chalk.bold('  Summary'));
  console.log(chalk.dim('  ' + '\u2500'.repeat(40)));
  console.log(`  Status:   ${status === 'completed' ? chalk.green('\u2713 completed') : chalk.red('\u2717 ' + status)}`);
  console.log(`  Tokens:   ${totalTokens.toLocaleString()}`);
  console.log(`  Cost:     $${totalCost.toFixed(4)}`);
  console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log();
}

async function nbPlan(client: GenesisClient, prompt: string): Promise<void> {
  if (!prompt) {
    console.log(chalk.red('  Usage: /nb plan <task description>'));
    return;
  }

  console.log(chalk.bold(`\n  Planning notebook from prompt...\n`));
  console.log(chalk.dim(`  "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`));
  console.log();

  const spinner = ora('  LLM is decomposing task into cells...').start();
  const result = await client.post('/notebooks/plan', {
    prompt,
    agent: 'atlas',
    effort: 7,
  });
  spinner.stop();

  if (!result || !result.id) {
    console.log(chalk.red('  Planning failed. Check Genesis logs.'));
    return;
  }

  const width = Math.min(process.stdout.columns || 100, 120);
  const nbId = result.id || result.metadata?.id;
  const cells = result.cells || [];

  console.log(chalk.green(`  \u2713 Notebook created: ${chalk.cyan(nbId)}`));
  console.log(chalk.dim(`  Cells: ${cells.length}`));
  console.log();

  // Show planned cells
  cells.forEach((cell: any, i: number) => {
    const cellInfo: CellInfo = {
      id: cell.id || `cell_${i}`,
      type: cell.type,
      name: cell.name || cell.type,
      config: cell.config || {},
      status: 'pending',
    };
    console.log(renderCell(cellInfo, i, cells.length, width));
    console.log();
  });

  console.log(chalk.bold('  Next steps:'));
  console.log(chalk.dim(`    /nb open ${nbId}     \u2500 Start interactive session`));
  console.log(chalk.dim(`    /nb run ${nbId}      \u2500 Execute all cells`));
  console.log();
}

async function nbCreate(client: GenesisClient, name: string): Promise<void> {
  if (!name) {
    console.log(chalk.red('  Usage: /nb create <name>'));
    return;
  }

  const spinner = ora('Creating notebook...').start();
  const result = await client.post('/notebooks/', { name, cells: [] });
  spinner.stop();

  if (!result || !result.id) {
    console.log(chalk.red('  Creation failed.'));
    return;
  }

  console.log(chalk.green(`  \u2713 Notebook created: ${chalk.cyan(result.id)}`));
  console.log(chalk.dim(`    /nb open ${result.id}`));
  console.log();
}

async function nbTemplates(client: GenesisClient): Promise<void> {
  const spinner = ora('Loading templates...').start();
  const data = await client.get('/notebooks/templates');
  spinner.stop();

  if (!data || !data.templates || data.templates.length === 0) {
    console.log(chalk.dim('  No templates available.'));
    return;
  }

  console.log(chalk.bold(`\n  Notebook Templates (${data.templates.length})\n`));
  const rows = data.templates.map((t: any) => [
    `  ${chalk.cyan(t.id)}`,
    t.name || chalk.dim('(untitled)'),
    (t.tags || []).slice(0, 3).join(', ') || chalk.dim('-'),
  ]);
  console.log(formatTable(['  ID', 'Name', 'Tags'], rows));
  console.log();
}

async function nbSessions(client: GenesisClient): Promise<void> {
  const spinner = ora('Loading sessions...').start();
  const data = await client.get('/notebooks/sessions');
  spinner.stop();

  if (!data || !data.sessions || data.sessions.length === 0) {
    console.log(chalk.dim('  No active sessions.'));
    return;
  }

  console.log(chalk.bold(`\n  Active Sessions (${data.sessions.length})\n`));
  const rows = data.sessions.map((s: any) => [
    `  ${chalk.cyan(s.session_id)}`,
    s.notebook_id || '',
    String(s.executed_count ?? '?'),
    String(s.total_cells ?? '?'),
    s.status || chalk.dim('active'),
  ]);
  console.log(formatTable(['  Session', 'Notebook', 'Executed', 'Total', 'Status'], rows));
  console.log();
}

async function nbExport(client: GenesisClient, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const notebookId = parts[0];
  const outputPath = parts[1] || `${notebookId}.ipynb`;

  if (!notebookId) {
    console.log(chalk.red('  Usage: /nb export <notebook_id> [output.ipynb]'));
    return;
  }

  const spinner = ora(`Exporting ${notebookId} to .ipynb...`).start();

  try {
    const response = await fetch(
      `${client.baseUrl}/notebooks/${notebookId}/export`,
      { headers: { 'X-Caller-Type': 'PLATFORM' }, signal: AbortSignal.timeout(10000) },
    );

    if (!response.ok) {
      spinner.stop();
      console.log(chalk.red(`  Export failed: ${response.status} ${response.statusText}`));
      return;
    }

    const ipynb = await response.text();

    // Write to file
    const { writeFileSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    const fullPath = resolvePath(outputPath);
    writeFileSync(fullPath, ipynb, 'utf-8');
    spinner.stop();

    console.log(chalk.green(`  \u2713 Exported to ${chalk.cyan(fullPath)}`));
    console.log(chalk.dim(`    Open in VS Code:  code ${fullPath}`));
    console.log(chalk.dim(`    Open in Jupyter:  jupyter notebook ${fullPath}`));
    console.log();
  } catch (e: any) {
    spinner.stop();
    console.log(chalk.red(`  Export failed: ${e.message || e}`));
  }
}

async function nbInfo(client: GenesisClient, notebookId: string): Promise<void> {
  if (!notebookId) {
    console.log(chalk.red('  Usage: /nb info <notebook_id>'));
    return;
  }

  const spinner = ora('Loading notebook...').start();
  const data = await client.get(`/notebooks/${notebookId}`);
  spinner.stop();

  if (!data) {
    console.log(chalk.red(`  Notebook ${notebookId} not found.`));
    return;
  }

  const nb = data.notebook || data;
  const meta = nb.metadata || nb;
  const spec = nb.spec || {};
  const cells = nb.cells || [];
  const prov = nb.provenance || {};

  const width = Math.min(process.stdout.columns || 100, 120);

  console.log();
  console.log(chalk.bold.cyan(`  \u2584\u2584 ${meta.name || '(untitled)'}`));
  console.log(chalk.dim(`  ID: ${meta.id}`));
  console.log(chalk.dim(`  Created: ${meta.created_at || '?'} by ${meta.created_by || '?'}`));
  if (meta.goal_id) console.log(`  Goal: ${chalk.yellow(meta.goal_id)}`);
  if (meta.expedition_id) console.log(`  Expedition: ${chalk.magenta(meta.expedition_id)}`);
  if (prov.expedition_id) console.log(`  Expedition: ${chalk.magenta(prov.expedition_id)}`);
  if (meta.description) console.log(chalk.dim(`  ${meta.description.slice(0, 100)}`));
  console.log(chalk.dim(`  Mode: ${spec.execution_mode || 'sequential'} | Effort: ${spec.effort_budget || '?'}`));
  console.log(chalk.dim(`  Tags: ${(meta.tags || []).join(', ') || '-'}`));
  console.log();

  // Render cells
  cells.forEach((cell: any, i: number) => {
    const cellInfo: CellInfo = {
      id: cell.id,
      type: cell.type,
      name: cell.name || cell.type,
      config: cell.config || {},
      status: cell.status?.execution_status || 'pending',
    };
    console.log(renderCell(cellInfo, i, cells.length, width));
    console.log();
  });
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

export async function handleNotebook(
  client: GenesisClient,
  args: string,
  _config: ShellConfig,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'list':
    case 'ls':
      return nbList(client, rest);

    case 'open':
    case 'session':
      return nbOpen(client, rest);

    case 'run':
    case 'exec':
      return nbRun(client, rest);

    case 'plan':
      return nbPlan(client, rest);

    case 'create':
    case 'new':
      return nbCreate(client, rest);

    case 'info':
    case 'show':
      return nbInfo(client, rest);

    case 'export':
    case 'ipynb':
      return nbExport(client, rest);

    case 'templates':
    case 'tpl':
      return nbTemplates(client);

    case 'sessions':
      return nbSessions(client);

    default: {
      // /nb <number> — shortcut from the menu (e.g. /nb 1 = list)
      const menuNum = parseInt(sub);
      if (!isNaN(menuNum) && menuNum >= 1 && menuNum <= NB_SUBCOMMANDS.length) {
        const picked = NB_SUBCOMMANDS[menuNum - 1];
        if (!picked.args || rest) {
          return handleNotebook(client, `${picked.value} ${rest}`.trim(), _config);
        }
        // Needs args but none given — show usage
        console.log(chalk.yellow(`  /nb ${picked.label} requires <${picked.args}>`));
        return;
      }

      if (sub) {
        // If they passed an ID directly, treat as /nb info <id>
        if (sub.startsWith('nb_')) {
          return nbInfo(client, sub);
        }
        console.log(chalk.red(`  Unknown subcommand: ${sub}`));
      }
      // Show menu
      return nbPicker(client, _config);
    }
  }
}

// ── Interactive subcommand picker ────────────────────────────────────────────

const NB_SUBCOMMANDS = [
  { value: 'list',      label: 'list',      desc: 'List all notebooks',                   args: false },
  { value: 'plan',      label: 'plan',      desc: 'Create notebook from natural language', args: 'prompt' },
  { value: 'open',      label: 'open',      desc: 'Open interactive session (cell-by-cell)', args: 'id' },
  { value: 'run',       label: 'run',       desc: 'Execute entire notebook',              args: 'id' },
  { value: 'create',    label: 'create',    desc: 'Create empty notebook',                args: 'name' },
  { value: 'info',      label: 'info',      desc: 'Show notebook details + cells',        args: 'id' },
  { value: 'export',    label: 'export',    desc: 'Export as .ipynb (VS Code / Jupyter)',  args: 'id' },
  { value: 'templates', label: 'templates', desc: 'List available templates',              args: false },
  { value: 'sessions',  label: 'sessions',  desc: 'List active kernel sessions',          args: false },
];

async function nbPicker(_client: GenesisClient, _config: ShellConfig): Promise<void> {
  console.log(chalk.bold('\n  /nb \u2014 Agent Notebooks\n'));

  NB_SUBCOMMANDS.forEach((cmd, i) => {
    const num = chalk.dim(`  ${(i + 1).toString().padStart(2)}.`);
    const name = chalk.cyan(cmd.label.padEnd(12));
    const argHint = cmd.args ? chalk.dim(` <${cmd.args}>`) : '';
    console.log(`${num} ${name}${argHint}  ${chalk.dim(cmd.desc)}`);
  });

  console.log();
  console.log(chalk.dim('  Type: /nb <command> [args]    e.g. /nb list, /nb plan "fix auth"'));
  console.log();
}
