import { getActiveConfig } from './config.js';
/**
 * Tab completion for commands, @agent mentions, and !shell shortcuts.
 */

import type { GenesisClient } from './client.js';
import { getCommandNames } from './commands.js';
import { getCommandRegistry } from './command-registry.js';

// Build initial list from static commands; refreshed after dynamic loading
let COMMAND_NAMES = [...getCommandNames().map(n => `/${n}`), '/jobs'];

/**
 * Refresh the completion command list from the registry.
 * Called after loadDynamicCommands() merges new commands.
 */
export function refreshCommandCompletions(): void {
  const registry = getCommandRegistry();
  const allNames = registry.allNames();
  const mcpTools = registry.getMcpTools().map(t => t.name);
  COMMAND_NAMES = [
    ...new Set([
      ...allNames.map(n => `/${n}`),
      ...mcpTools.map(n => `/${n}`),
      '/jobs',
      '/gui',
      '/password',
      // Whatever the launched pack contributes, so tab-completion offers a
      // pack's commands the same way it offers the shell's.
      ...((): string[] => {
        try {
          const cfg = getActiveConfig();
          return (cfg?.packCommands || []).map(c => `/${c.name}`);
        } catch { return []; }
      })(),
    ]),
  ].sort();
}

// Common shell commands for ! completion
const SHELL_HINTS = [
  '!docker ps', '!docker compose', '!docker logs',
  '!git status', '!git log --oneline -10', '!git diff',
  '!pwsh', '!ls', '!cat', '!curl',
  '!Get-AitherStatus', '!Get-AitherContainer',
];

// Fallback agent names when Genesis is unreachable
const DEFAULT_AGENTS = [
  'aither', 'personal', 'demiurge', 'athena', 'atlas', 'hydra',
  'apollo', 'prometheus', 'scribe', 'viviane', 'hera',
  'isolde', 'prospero', 'ignis', 'terra', 'vera',
];

// Strategy directives — passed through to Genesis StrategyResolver, not agent routes
export const STRATEGY_DIRECTIVES: { trigger: string; hint: string }[] = [
  { trigger: 'code',        hint: 'Force code context — codegraph + architecture + tools' },
  { trigger: 'research',    hint: 'Deep web research + synthesis pipeline' },
  { trigger: 'internal',    hint: 'Full AitherOS internal context (platform only)' },
  { trigger: 'quick',       hint: 'Fast response, no deliberation (effort 1–3)' },
  { trigger: 'think',       hint: 'Deep reasoning with extended deliberation' },
  { trigger: 'reason',      hint: 'Full reasoning model + structured analysis' },
  { trigger: 'agentic',     hint: 'Force agentic ReAct loop with tools' },
  { trigger: 'debug',       hint: 'PRISM-powered debugging — 6 expert personas' },
  { trigger: 'troubleshoot', hint: 'Systematic service troubleshooting' },
  { trigger: 'investigate', hint: 'Deep exploratory investigation — long tool chains' },
  { trigger: 'council',     hint: '6-specialist council review before responding' },
  { trigger: 'deliberate',  hint: 'Parallel thought streams + convergence' },
  { trigger: 'swarm',       hint: 'Full 11-agent swarm coding (Forge mode)' },
  { trigger: 'compete',     hint: 'Multiple strategies in parallel — best judged' },
  { trigger: 'personal',    hint: 'Personal assistant mode' },
  { trigger: 'chat',        hint: 'Companion mode — fast, natural conversation (persists)' },
  { trigger: 'companion',   hint: 'Companion mode — fast, natural conversation (persists)' },
  { trigger: 'talk',        hint: 'Companion mode — fast, natural conversation (persists)' },
];

let cachedAgents: string[] = [];
/** Maps lowercase alias → canonical agent name (built from directory). */
let agentAliasMap: Record<string, string> = {};

// Common short-name aliases that map to canonical agent IDs.
// These mirror AGENT_MENTION_MAP in intent_classifier.py.
const BUILTIN_ALIASES: Record<string, string> = {
  demi: 'demiurge',
  forge: 'demiurge',
  swarm: 'demiurge',
  assistant: 'personal',
};

export async function loadAgentNames(client: GenesisClient): Promise<string[]> {
  if (cachedAgents.length) return cachedAgents;
  try {
    const result = await client.getAgents();
    const agents = (result?.agents || []).map((a: any) => {
      // Genesis uses a.id, ADK uses a.name/a.identity — accept all
      const id = (a.id || a.identity || a.name || '').toLowerCase();
      const name = (a.name || a.id || a.identity || '').toLowerCase();
      return { id, name };
    }).filter((a: any) => a.id);
    if (agents.length) {
      cachedAgents = agents.map((a: any) => a.id);
      // Build alias map: both id and display name point to canonical id
      agentAliasMap = {};
      for (const a of agents) {
        agentAliasMap[a.id] = a.id;
        if (a.name && a.name !== a.id) {
          agentAliasMap[a.name] = a.id;
        }
      }
      // Add built-in short aliases
      for (const [alias, canonical] of Object.entries(BUILTIN_ALIASES)) {
        if (!agentAliasMap[alias]) {
          agentAliasMap[alias] = canonical;
        }
      }
    } else {
      cachedAgents = DEFAULT_AGENTS;
      agentAliasMap = Object.fromEntries(DEFAULT_AGENTS.map(a => [a, a]));
      for (const [alias, canonical] of Object.entries(BUILTIN_ALIASES)) {
        agentAliasMap[alias] = canonical;
      }
    }
  } catch {
    cachedAgents = DEFAULT_AGENTS;
    agentAliasMap = Object.fromEntries(DEFAULT_AGENTS.map(a => [a, a]));
    for (const [alias, canonical] of Object.entries(BUILTIN_ALIASES)) {
      agentAliasMap[alias] = canonical;
    }
  }
  return cachedAgents;
}

/**
 * Resolve an @mention to a canonical agent name using the directory.
 * Returns { resolved: canonicalName } on success, { unknown: rawName } on failure.
 */
export function resolveAgentMention(mention: string): { resolved?: string; unknown?: string } {
  const key = mention.toLowerCase();
  const canonical = agentAliasMap[key];
  if (canonical) return { resolved: canonical };
  // Fuzzy: check if it's a prefix of exactly one agent
  const prefixMatches = cachedAgents.filter(a => a.toLowerCase().startsWith(key));
  if (prefixMatches.length === 1) return { resolved: prefixMatches[0].toLowerCase() };
  return { unknown: mention };
}

/** Get all known agent names + aliases for completions. */
export function getAgentCompletionNames(): string[] {
  return [...new Set([...cachedAgents, ...Object.keys(agentAliasMap)])];
}

// Subcommand completions for commands that have them
// Each entry: [name, argHint] — argHint is '' for no-arg subcommands
export const SUBCOMMAND_DEFS: Record<string, [string, string][]> = {
  '/storage': [
    ['nodes', '— which nodes have scanned, how stale'],
    ['inventory', '[--node N] [--root R] [--top 25] [--cls C] [--refetchable] — ranked disk consumers'],
    ['diff', '--node N --root R [--from-id ID] [--to-id ID] — added/removed/grown/shrunk'],
    ['proposals', '[--node N] [--status proposed|all] — pending/answered reclaim proposals'],
    ['ledger', '[--node N] [--limit 200] — what apply actually did'],
    ['policy', '— the effective fleet policy (read-only)'],
    ['scan', '--local <root> — run the scanner here, no fleet needed'],
  ],
  '/onboard': [
    ['auto', '<path> [name] — Auto-detect code vs knowledge'],
    ['code', '<path> [name] — Index a local codebase'],
    ['knowledge', '<path> [name] — Ingest a knowledge directory'],
    ['repo', '<git-url> [name] — Import a remote repository into workspace'],
  ],
  '/obsidian': [
    ['setup', '[vault-path] — Install plugin into an Obsidian vault'],
    ['status', '— Check plugin install status across vaults'],
  ],
  '/scope': [
    ['graph', '[path] — Fetch dependency graph'],
    ['dead', '[path] — Find dead/unreachable code'],
    ['metrics', '[path] — Codebase metrics summary'],
    ['health', '— Check CodeGraph service health'],
    ['reindex', '[path] — Force re-index codebase'],
  ],
  '/nb': [
    ['list', ''],
    ['plan', '<prompt>'],
    ['open', '<id>'],
    ['run', '<id>'],
    ['create', '<name>'],
    ['info', '<id>'],
    ['export', '<id> [path]'],
    ['templates', ''],
    ['sessions', ''],
  ],
  '/notebook': [
    ['list', ''],
    ['plan', '<prompt>'],
    ['open', '<id>'],
    ['run', '<id>'],
    ['create', '<name>'],
    ['info', '<id>'],
    ['export', '<id> [path]'],
    ['templates', ''],
    ['sessions', ''],
  ],
  '/jobs': [
    ['cancel', '<id>'],
  ],
  '/safety': [
    ['status', ''],
    ['levels', ''],
    ['set', '<professional|casual|unrestricted|explicit> [--context <ctx>] [--scope <scope>]'],
    ['resolve', '[--scope <scope>] [--context <ctx>] [--user <id>] [--tenant <slug>] [--agent <id>]'],
    ['age-status', ''],
    ['verify-age', '<YYYY-MM-DD>'],
    ['platform', ''],
    ['tenant', '[slug]'],
    ['agent', '<agent_id>'],
  ],
  '/calendar': [
    ['list', '— Show upcoming events'],
    ['create', '"<title>" --start <ISO> [--end <ISO>]'],
    ['delete', '<id>'],
    ['sync', '— Trigger CalDAV sync'],
  ],
  '/cal': [
    ['list', ''],
    ['create', '"<title>" --start <ISO>'],
    ['delete', '<id>'],
    ['sync', ''],
  ],
  '/mail': [
    ['inbox', '— Show inbox'],
    ['send', '"<subject>" --body "<text>" [--priority high]'],
    ['threads', '— List email threads'],
    ['read', '<thread_id>'],
  ],
  '/email': [
    ['inbox', ''],
    ['send', '"<subject>" --body "<text>"'],
    ['threads', ''],
    ['read', '<thread_id>'],
  ],
  '/will': [
    ['active', '— Show current will policy'],
    ['list', '— Available wills'],
    ['activate', '<id>'],
    ['policy', '— Full policy detail'],
  ],
  '/escalate': [
    ['list', '— Pending proposals'],
    ['config', '— Show escalation config'],
    ['approve', '<id>'],
    ['deny', '<id> [reason]'],
    ['set', '<key> <value>'],
  ],
  '/research': [
    ['"<topic>"', '[--depth quick|deep] [--report]'],
  ],
  '/publish': [
    ['blog', '"<topic>" — Generate blog post'],
    ['social', '"<message>" — Craft social post'],
    ['status', '— Content deck status'],
  ],
  '/routines': [
    ['list', '— Show all routines'],
    ['run', '<id>'],
    ['create', '<json>'],
    ['enable', '<id>'],
    ['disable', '<id>'],
    ['edit', '<id> <json>'],
    ['history', '— Recent execution history'],
    ['pause', '— Pause all routines'],
    ['resume', '— Resume routines'],
    ['status', '— Scheduler status'],
  ],
  '/expedition': [
    ['list', '— Active expeditions'],
    ['create', '<name>'],
    ['status', '<id>'],
    ['gate', '<id> approve|reject'],
    ['run', '"<goal>" — Full autonomous orchestration'],
    ['stream', '<id> — SSE event stream'],
    ['cancel', '<id>'],
  ],
  '/products': [
    ['list', '— Running product instances'],
    ['catalog', '— Available products'],
    ['deploy', '<type> — Deploy a product instance'],
    ['status', '<id> — Instance status'],
    ['destroy', '<id> — Remove an instance'],
    ['failover', '<id> — Activate cloud failover'],
  ],
  '/prod': [
    ['list', ''],
    ['catalog', ''],
    ['deploy', '<type>'],
    ['status', '<id>'],
    ['destroy', '<id>'],
    ['failover', '<id>'],
  ],
  '/tool-scope': [
    ['show', '— Current tool access config'],
    ['allow', '<tool> — Allow a tool'],
    ['deny', '<tool> — Deny a tool'],
  ],
  '/compose': [
    ['interactive', '— Launch agent composer wizard'],
  ],
  '/monitor': [
    ['all', '— All agent metrics'],
  ],
  '/docker': [
    ['up', '[service] — Start containers'],
    ['down', '[service] — Stop containers'],
    ['status', '— Container status'],
    ['build', '[service] — Build images'],
    ['restart', '[service] — Restart containers'],
    ['logs', '<service> — View logs'],
    ['ps', '— List running containers'],
  ],
  '/dc': [
    ['up', '[service]'],
    ['down', '[service]'],
    ['status', ''],
    ['build', '[service]'],
    ['restart', '[service]'],
    ['logs', '<service>'],
    ['ps', ''],
  ],

  // ── Auto-derived from each command's usage string (kept in sync there). ──
  // These let the generic interactive engine (interactive.ts) prompt for a
  // subcommand + its arguments when the command is invoked bare. Single-entry
  // tables whose first element is a placeholder (<x>/[x]/"x") prompt directly
  // for that positional with no subcommand menu.
  '/chats': [
    ['resume', '<id>'],
    ['delete', '<id>'],
  ],
  '/apps': [
    ['status', '[desktop|node|veil|connect|shell]'],
    ['install', '<desktop|node|veil|connect|shell>'],
    ['start', '<desktop|node|veil|connect|shell>'],
    ['stop', '<desktop|node|veil|connect|shell>'],
  ],
  '/gaming': [
    ['status', ''],
    ['on', ''],
    ['off', ''],
    ['pause', ''],
  ],
  '/lockbox': [
    ['list', ''],
    ['add', '<name> <content>'],
    ['add-file', '<name> <path>'],
    ['remove', '<id>'],
    ['sync', ''],
  ],
  '/soul': [
    ['list', ''],
    ['load', '<name>'],
    ['active', ''],
  ],
  '/fleet': [
    ['status', ''],
    ['launch', ''],
    ['drain', '<id>'],
    ['refresh', '[--build-only] [--recreate-only] [--dry-run]'],
  ],
  '/node': [
    ['ls', ''],
    ['enroll', '[--tenant <t>] [--ttl <hours>] [--label <l>]'],
    ['rm', '<id>'],
  ],
  '/workflow': [
    ['list', ''],
    ['run', '<id>'],
    ['create', '<yaml_path>'],
  ],
  '/benchmark': [
    ['run', ''],
    ['history', ''],
  ],
  '/review': [
    ['diff', ''],
    ['file', '<path>'],
  ],
  '/backup': [
    ['list', ''],
    ['now', ''],
  ],
  '/grid': [
    ['status', ''],
    ['add', ''],
    ['remove', ''],
    ['test', ''],
    ['sync', ''],
    ['pull', ''],
  ],
  '/explore': [
    ['all', '[--free]'],
    ['agents', '[--free]'],
    ['tools', '[--free]'],
    ['skills', '[--free]'],
    ['grid', '[--free]'],
  ],
  '/security': [
    ['scan', ''],
    ['status', ''],
  ],
  '/train': [
    ['status', ''],
    ['start', ''],
  ],
  '/demo': [
    ['start', ''],
    ['stop', ''],
    ['status', ''],
    ['logs', ''],
  ],
  '/github': [
    ['prs', ''],
    ['issues', ''],
    ['releases', ''],
    ['ci', ''],
    ['merge', '<pr>'],
  ],
  '/secrets': [
    ['list', ''],
    ['get', '<key>'],
    ['set', '<key> <value>'],
    ['delete', '<key>'],
  ],
  '/rbac': [
    ['users', ''],
    ['roles', ''],
    ['groups', ''],
    ['check', '<user> <permission>'],
  ],
  '/acc': [
    ['stats', ''],
    ['friction', ''],
    ['unstable', ''],
    ['node', '<id>'],
  ],
  '/sttp': [
    ['list', ''],
    ['get', ''],
    ['calibrate', ''],
    ['store', '<content>'],
  ],
  '/stacks': [
    ['list', ''],
    ['status', ''],
    ['switch', '<name>'],
  ],
  '/cloud': [
    ['models', ''],
    ['offers', ''],
    ['active', ''],
    ['billing', ''],
    ['deploy', '<model>'],
    ['status', '[id]'],
    ['teardown', '<id>'],
    ['cost', '<model>'],
  ],
  '/context': [
    ['dashboard', ''],
    ['layers', ''],
    ['snapshot', ''],
  ],
  '/memory': [
    ['recall', '<query>'],
    ['remember', '<text>'],
    ['forget', '<text>'],
  ],
  '/models': [
    ['status', ''],
    ['list', ''],
    ['use', '<profile>'],
    ['set', '<slot> <model>'],
    ['route', '<tier> <model> [backend]'],
  ],
  '/deepseek': [
    ['status', ''],
    ['on', ''],
    ['off', ''],
    ['test', ''],
  ],
  '/kimi': [
    ['on', ''],
    ['off', ''],
  ],
  '/pool': [
    ['status', ''],
    ['reset', ''],
  ],
  '/compute': [
    ['status', ''],
    ['discover', ''],
    ['backends', ''],
    ['nodes', ''],
    ['scale', ''],
  ],
  '/sandbox': [
    ['list', ''],
    ['create', '[name]'],
    ['stop', '<id>'],
    ['exec', '<id> <command>'],
    ['files', '<id>'],
  ],
  '/dev': [
    ['list', ''],
    ['create', '[name] [lang]'],
    ['stop', '<id>'],
    ['codegen', '<id> <prompt>'],
    ['exec', '<id> <cmd>'],
    ['task', '<id> <task>'],
    ['open', '<id>'],
  ],
  '/atlas': [
    ['board', '[--items <N>] [--sync]'],
    ['tick', '[--items <N>] [--sync]'],
  ],
  '/gateway': [
    ['mint', '<tenant> [scopes] [days]'],
  ],
  // Single required/optional positional — prompt directly, no subcommand menu.
  '/search': [['<query>', '']],
  '/codegraph': [['<query>', '']],
  '/think': [['<problem>', '[--effort <7-10>]']],
  '/deploy': [['<service_name>', '']],
  '/repowise': [['<question>', '']],
  '/speak': [['<text>', '[--voice <name>]']],
  '/ingest': [['<url-or-file>', '[--agent <NAME>] [--workspace <ID>]']],
  '/inbox': [['[agent_name]', '']],
  '/approve': [['<username>', '']],
  '/resume': [['<session_id>', '[prompt]']],
  '/lyra': [['"<question>"', '[--effort quick_glance|library_session|deep_dive|leave_no_stone]']],
  '/generate': [['[prompt]', '[--style <style>] [--size <WxH>] [--model <name>]']],
  '/v4': [['<prompt>', '']],
};

// Flat list for tab completion. Placeholder "names" (<x>, [x], "x") are positional
// argument prompts for the interactive engine, not real subcommand verbs — drop
// them here so tab-completion only ever offers actual subcommands.
export const SUBCOMMANDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(SUBCOMMAND_DEFS)
    .map(([cmd, defs]) => [cmd, defs.map(([name]) => name).filter(n => !/^["<[]/.test(n))] as [string, string[]])
    .filter(([, subs]) => (subs as string[]).length > 0)
);

export function completer(agents: string[]) {
  return (line: string): [string[], string] => {
    // Slash commands
    if (line.startsWith('/')) {
      // Subcommand completion: "/nb li" → "/nb list"
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx > 0) {
        const cmd = line.slice(0, spaceIdx);
        const partial = line.slice(spaceIdx + 1);

        // /imagine value hints — --backend and --model offer their valid values,
        // and bare "/imagine <Tab>" offers the backends/models subcommands.
        if (cmd === '/imagine') {
          const IMAGE_BACKENDS = ['sana', 'comfyui', 'gemini', 'openai'];
          const IMAGE_MODELS = ['sprint', 'quality'];
          const mBackend = line.match(/^(.*(?:--backend|-b)\s+)(\S*)$/);
          if (mBackend) {
            const [, pre, part] = mBackend;
            const opts = IMAGE_BACKENDS.filter(b => b.startsWith(part));
            return [(opts.length ? opts : IMAGE_BACKENDS).map(b => pre + b), line];
          }
          const mModel = line.match(/^(.*(?:--model|-m)\s+)(\S*)$/);
          if (mModel) {
            const [, pre, part] = mModel;
            const opts = IMAGE_MODELS.filter(b => b.startsWith(part));
            return [(opts.length ? opts : IMAGE_MODELS).map(b => pre + b), line];
          }
          const subs = ['backends', 'models'];
          const hits = subs.filter(s => s.startsWith(partial)).map(s => `${cmd} ${s}`);
          if (hits.length) return [hits, line];
          return [[], line];
        }

        const subs = SUBCOMMANDS[cmd];
        if (subs) {
          const hits = subs
            .filter(s => s.startsWith(partial))
            .map(s => `${cmd} ${s}`);
          return [hits.length ? hits : subs.map(s => `${cmd} ${s}`), line];
        }
        return [[], line];
      }
      const hits = COMMAND_NAMES.filter(c => c.startsWith(line));
      return [hits.length ? hits : COMMAND_NAMES, line];
    }

    // @agent mentions and @strategy directives
    if (line.startsWith('@')) {
      const partial = line.slice(1).toLowerCase();
      // Strategy directives first, then agents
      const directiveHits = STRATEGY_DIRECTIVES
        .filter(d => d.trigger.startsWith(partial))
        .map(d => `@${d.trigger} `);
      const agentHits = agents
        .filter(a => a.toLowerCase().startsWith(partial))
        .map(a => `@${a} `);
      const allHits = [...directiveHits, ...agentHits];
      if (allHits.length) return [allHits, line];
      // No matches — show everything
      const allOptions = [
        ...STRATEGY_DIRECTIVES.map(d => `@${d.trigger} `),
        ...agents.map(a => `@${a} `),
      ];
      return [allOptions, line];
    }

    // !shell escape hints
    if (line.startsWith('!')) {
      const hits = SHELL_HINTS.filter(h => h.startsWith(line));
      return [hits.length ? hits : SHELL_HINTS, line];
    }

    return [[], line];
  };
}
