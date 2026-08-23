/**
 * CommandRegistry — Score-based command matching and dynamic loading.
 *
 * Loads commands from:
 *   1. commands.json (static definitions — immediate, offline fallback)
 *   2. Genesis /shell/commands (aggregated catalog — all sources)
 *   3. Genesis /shell/commands/mcp (MCP tools as callable commands)
 *   4. Built-in handlers from commands.ts
 *
 * At REPL startup, loadDynamicCommands() fetches from Genesis and merges
 * new commands into the registry. Static commands.json is never manually
 * edited again — it serves as an offline fallback only.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import { getRemoteMcpClient } from './mcp-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CommandEntry {
  name: string;
  category: string;
  description: string;
  aliases: string[];
  subcommands: string[];
  source: string;
  handler?: (client: GenesisClient, args: string, config: ShellConfig) => Promise<void>;
  genesisEndpoint?: string;
}

interface CommandJSON {
  commands: Array<{
    name: string;
    category: string;
    description: string;
    aliases: string[];
  }>;
}

interface DynamicCommandEntry {
  name: string;
  category: string;
  description: string;
  aliases: string[];
  subcommands?: string[];
  source: string;
  genesis_endpoint?: string;
  params?: any[];
}

// ── Tokenizer ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'and', 'or', 'not', 'it', 'this', 'that', 'my',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-/.]+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

// ── Registry ─────────────────────────────────────────────────────────

export class CommandRegistry {
  private commands: Map<string, CommandEntry> = new Map();
  private aliasMap: Map<string, string> = new Map();
  private dynamicLoaded = false;

  /** MCP tools discovered from Genesis — callable via /tools/call. */
  private mcpTools: Map<string, DynamicCommandEntry> = new Map();

  constructor() {
    this.loadFromJSON();
  }

  private loadFromJSON(): void {
    try {
      const jsonPath = resolve(__dirname, '..', 'commands.json');
      const raw = readFileSync(jsonPath, 'utf-8');
      const data: CommandJSON = JSON.parse(raw);

      for (const cmd of data.commands) {
        this.commands.set(cmd.name, {
          name: cmd.name,
          category: cmd.category,
          description: cmd.description,
          aliases: cmd.aliases || [],
          subcommands: [],
          source: 'static',
        });

        for (const alias of cmd.aliases || []) {
          this.aliasMap.set(alias, cmd.name);
        }
      }
    } catch {
      // commands.json not found — rely on dynamic loading + built-in handlers
    }
  }

  /**
   * Fetch the unified command catalog from Genesis /shell/commands.
   * Merges discovered commands into the registry without overwriting
   * existing handlers. Call once at REPL startup.
   */
  async loadDynamicCommands(client: GenesisClient, config?: ShellConfig): Promise<number> {
    let added = 0;
    try {
      const result = await client.get('/shell/commands');
      const commands: DynamicCommandEntry[] = result?.commands || [];

      for (const cmd of commands) {
        if (!cmd.name) continue;

        const existing = this.commands.get(cmd.name);
        if (existing) {
          // Merge subcommands and metadata from dynamic source
          if (cmd.subcommands?.length && !existing.subcommands.length) {
            existing.subcommands = cmd.subcommands;
          }
          if (cmd.genesis_endpoint && !existing.genesisEndpoint) {
            existing.genesisEndpoint = cmd.genesis_endpoint;
          }
          if (cmd.source && !existing.source.includes(cmd.source)) {
            existing.source = `${existing.source}+${cmd.source}`;
          }
        } else {
          // New command discovered from Genesis
          this.commands.set(cmd.name, {
            name: cmd.name,
            category: cmd.category || 'custom',
            description: cmd.description || '',
            aliases: cmd.aliases || [],
            subcommands: cmd.subcommands || [],
            source: cmd.source || 'dynamic',
            genesisEndpoint: cmd.genesis_endpoint,
          });
          for (const alias of cmd.aliases || []) {
            if (!this.aliasMap.has(alias)) {
              this.aliasMap.set(alias, cmd.name);
            }
          }
          added++;
        }
      }

      this.dynamicLoaded = true;
    } catch {
      // Genesis unreachable — use static commands only
    }

    // Also fetch MCP tools from the chat backend (Genesis exposes these via
    // /shell/commands/mcp). Non-fatal — the gateway has no such endpoint.
    try {
      const mcpResult = await client.get('/shell/commands/mcp');
      const mcpCommands: DynamicCommandEntry[] = mcpResult?.commands || [];
      for (const tool of mcpCommands) {
        if (tool.name) {
          this.mcpTools.set(tool.name, tool);
        }
      }
    } catch {
      // MCP discovery failed — non-fatal
    }

    // Remote MCP gateway (config.mcpUrl, e.g. mcp.aitherium.com/mcp): list the
    // tenant-scoped tool catalog over the MCP protocol. This is how awnode
    // tools become available in-REPL when pointed at a cloud workspace.
    const remote = getRemoteMcpClient(config);
    if (remote) {
      try {
        const tools = await remote.listTools();
        for (const tool of tools) {
          if (!tool.name) continue;
          this.mcpTools.set(tool.name, {
            name: tool.name,
            category: 'mcp',
            description: tool.description || '',
            aliases: [],
            source: 'remote-mcp',
            params: tool.inputSchema ? [tool.inputSchema] : [],
          });
        }
      } catch {
        // Remote MCP unreachable / unauthenticated — non-fatal.
      }
    }

    return added;
  }

  /** Get all discovered MCP tools. */
  getMcpTools(): DynamicCommandEntry[] {
    return [...this.mcpTools.values()];
  }

  /** Check if an MCP tool exists by name. */
  getMcpTool(name: string): DynamicCommandEntry | undefined {
    return this.mcpTools.get(name);
  }

  /** Register a built-in handler for a command. */
  registerHandler(
    name: string,
    handler: CommandEntry['handler'],
  ): void {
    const existing = this.commands.get(name);
    if (existing) {
      existing.handler = handler;
    } else {
      this.commands.set(name, {
        name,
        category: 'custom',
        description: '',
        aliases: [],
        subcommands: [],
        source: 'runtime',
        handler,
      });
    }
  }

  /** Resolve a command name (handles aliases). */
  resolve(input: string): CommandEntry | undefined {
    const lower = input.toLowerCase();
    const name = this.aliasMap.get(lower) || lower;
    return this.commands.get(name);
  }

  /** Get all command names (including aliases). */
  allNames(): string[] {
    const names = [...this.commands.keys()];
    const aliases = [...this.aliasMap.keys()];
    return [...new Set([...names, ...aliases])].sort();
  }

  /** Get all commands. */
  allCommands(): CommandEntry[] {
    return [...this.commands.values()];
  }

  /** Whether dynamic commands have been loaded from Genesis. */
  isDynamicLoaded(): boolean {
    return this.dynamicLoaded;
  }

  /** Score-based fuzzy matching for tab completion. */
  match(partial: string, limit = 5): string[] {
    const tokens = tokenize(partial);
    if (!tokens.length) return this.allNames().slice(0, limit);

    const scored: Array<[string, number]> = [];

    for (const [name, cmd] of this.commands) {
      let score = 0;

      // Exact prefix match on name
      if (name.startsWith(partial.toLowerCase())) {
        score += 10;
      }

      // Token overlap with name + description
      const docTokens = tokenize(`${name} ${cmd.description} ${cmd.aliases.join(' ')}`);
      for (const qt of tokens) {
        for (const dt of docTokens) {
          if (dt === qt) score += 3;
          else if (dt.startsWith(qt) || qt.startsWith(dt)) score += 1;
        }
      }

      if (score > 0) {
        scored.push([name, score]);
      }
    }

    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, limit).map(([name]) => name);
  }

  /** Get commands by category. */
  byCategory(): Map<string, CommandEntry[]> {
    const cats = new Map<string, CommandEntry[]>();
    for (const cmd of this.commands.values()) {
      const list = cats.get(cmd.category) || [];
      list.push(cmd);
      cats.set(cmd.category, list);
    }
    return cats;
  }

  get size(): number {
    return this.commands.size;
  }
}

// ── Singleton ────────────────────────────────────────────────────────

let _instance: CommandRegistry | null = null;

export function getCommandRegistry(): CommandRegistry {
  if (!_instance) {
    _instance = new CommandRegistry();
  }
  return _instance;
}
