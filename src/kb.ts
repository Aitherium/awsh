/**
 * KB CLI commands — chat, ingest, search, status, and Obsidian sync.
 *
 * A client for a knowledge-management service (documents, search, and
 * question-answering over a corpus). The service URL comes from
 * `AITHER_KB_URL`, `~/.aither/kb.json`, or the localhost default.
 *
 * Usage:
 *   aither kb chat "What projects did we do in Texas?"
 *   aither kb ingest ./resumes/john_doe.pdf
 *   aither kb search "bridge engineers with PE"
 *   aither kb status
 *   aither kb sync-obsidian /path/to/vault
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getKbUrl(): string {
  // 1. Environment variable
  if (process.env.AITHER_KB_URL) return process.env.AITHER_KB_URL;

  // 2. Config file ~/.aither/kb.json
  const configPath = path.join(os.homedir(), '.aither', 'kb.json');
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.url) return cfg.url;
    }
  } catch { /* fallthrough */ }

  // 3. Default
  return 'http://localhost:8900';
}

async function kbGet(endpoint: string): Promise<any> {
  const url = `${getKbUrl()}${endpoint}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function kbPost(endpoint: string, body: any): Promise<any> {
  const url = `${getKbUrl()}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function kbUpload(endpoint: string, filePath: string, fields: Record<string, string> = {}): Promise<any> {
  const url = `${getKbUrl()}${endpoint}`;
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // Build multipart form data manually for Node fetch
  const boundary = '----AitherShellBoundary' + Date.now().toString(36);
  let body = '';
  for (const [key, val] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(body, 'utf-8'),
    fileBuffer,
    Buffer.from(ending, 'utf-8'),
  ]);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Subcommand handlers ──────────────────────────────────────────────────

async function handleChat(args: string[]): Promise<void> {
  const message = args.join(' ');
  if (!message) {
    console.log('\x1b[33mUsage:\x1b[0m aither kb chat <message>');
    return;
  }
  console.log('\x1b[2mThinking...\x1b[0m');
  try {
    const data = await kbPost('/api/chat', { message });
    console.log(`\n\x1b[36mKB:\x1b[0m ${data.response}`);
    if (data.sources?.length > 0) {
      console.log(`\n\x1b[2mSources: ${data.sources.map((s: any) => s.filename).join(', ')}\x1b[0m`);
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function handleIngest(args: string[]): Promise<void> {
  const target = args[0];

  // If no args and stdin is piped, read from stdin
  if (!target && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf-8').trim();
    if (!text) {
      console.error('\x1b[31mNo input received from stdin\x1b[0m');
      return;
    }
    console.log('\x1b[2mIngesting from stdin...\x1b[0m');
    try {
      const data = await kbPost('/api/documents/ingest', {
        text,
        filename: `stdin-${Date.now()}`,
        doc_type: 'other',
      });
      console.log(`\x1b[32m✓\x1b[0m Ingested stdin (${data.chunks_created || '?'} chunks)`);
    } catch (e: any) {
      console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
    }
    return;
  }

  if (!target) {
    console.log('\x1b[33mUsage:\x1b[0m aither kb ingest <file-or-url>');
    console.log('       echo "text" | aither kb ingest');
    return;
  }

  // URL detection
  if (target.startsWith('http://') || target.startsWith('https://')) {
    console.log(`\x1b[2mIngesting URL: ${target}...\x1b[0m`);
    try {
      const data = await kbPost('/api/documents/ingest-url', { url: target, auto_extract: true });
      console.log(`\x1b[32m✓\x1b[0m Ingested: ${data.title || target} (${data.chunk_count || '?'} chunks)`);
    } catch (e: any) {
      console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
    }
    return;
  }

  // File path
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`\x1b[31mFile not found:\x1b[0m ${resolved}`);
    return;
  }
  console.log(`\x1b[2mIngesting ${path.basename(resolved)}...\x1b[0m`);
  try {
    const data = await kbUpload('/api/documents/upload', resolved, { auto_extract: 'true' });
    console.log(`\x1b[32m✓\x1b[0m Ingested: ${data.filename || path.basename(resolved)} (${data.chunk_count || data.chunks_created || '?'} chunks)`);
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function handleSearch(args: string[]): Promise<void> {
  const query = args.join(' ');
  if (!query) {
    console.log('\x1b[33mUsage:\x1b[0m aither kb search <query>');
    return;
  }
  try {
    const data = await kbPost('/api/chat', { message: `Search: ${query}` });
    console.log(`\n\x1b[36mResults:\x1b[0m ${data.response}`);
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function handleStatus(_args: string[]): Promise<void> {
  try {
    const health = await kbGet('/api/health');
    const stats = await kbGet('/api/stats');
    console.log(`\x1b[36mKB Status\x1b[0m`);
    console.log(`  Service:    ${health.service}`);
    console.log(`  Provider:   ${health.llm_provider}`);
    console.log(`  Mode:       ${health.deployment_mode}`);
    console.log(`  Documents:  ${stats.documents}`);
    console.log(`  Staff:      ${stats.staff}`);
    console.log(`  Projects:   ${stats.projects}`);
    console.log(`  Feedback:   ${stats.feedback_entries}`);
  } catch (e: any) {
    console.error(`\x1b[31mCannot reach KB:\x1b[0m ${e.message}`);
    console.log(`  URL: ${getKbUrl()}`);
  }
}

async function handleSyncObsidian(args: string[]): Promise<void> {
  const vaultPath = args[0];
  if (!vaultPath) {
    console.log('\x1b[33mUsage:\x1b[0m aither kb sync-obsidian <vault-path>');
    return;
  }
  console.log(`\x1b[2mSyncing vault: ${vaultPath}...\x1b[0m`);
  try {
    const data = await kbPost('/api/obsidian/sync', { vault_path: vaultPath });
    console.log(`\x1b[32m✓\x1b[0m Synced: ${data.total_files} files (${data.ingested} new, ${data.skipped} unchanged)`);
    if (data.error_count > 0) {
      console.log(`\x1b[33m  ⚠ ${data.error_count} errors\x1b[0m`);
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

// ── Main dispatcher ──────────────────────────────────────────────────────

export async function handleKbCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || 'help';
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'chat':
      return handleChat(subArgs);
    case 'ingest':
      return handleIngest(subArgs);
    case 'search':
      return handleSearch(subArgs);
    case 'status':
      return handleStatus(subArgs);
    case 'sync-obsidian':
    case 'sync':
      return handleSyncObsidian(subArgs);
    case 'help':
    default:
      console.log(`\x1b[36mKB CLI\x1b[0m — Knowledge management commands\n`);
      console.log('  aither kb chat <message>           Chat with the knowledge base');
      console.log('  aither kb ingest <file-or-url>     Ingest a document or URL');
      console.log('  echo "text" | aither kb ingest     Ingest from stdin');
      console.log('  aither kb search <query>           Search knowledge base');
      console.log('  aither kb status                   Show health & stats');
      console.log('  aither kb sync-obsidian <path>     Sync Obsidian vault');
      break;
  }
}
