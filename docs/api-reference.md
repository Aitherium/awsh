# awsh reference

This page covers the command line, the subcommands, the built-in slash
commands and the headless output format. For settings, see
[configuration.md](configuration.md).

## Command line

```text
awsh [flags] [message...]
```

With a message, awsh answers once and exits. Without one, it opens the
interactive shell. Flags can come before or after the message. Everything
after `--` is message text, so a prompt that starts with a dash still gets
through.

| flag | meaning |
|---|---|
| `-v`, `--version` | print `awsh <version>` and exit, without loading config or touching the network |
| `-c`, `--command <cmd>` | run one slash command (without the `/`) and exit, for example `awsh -c status` |
| `-f`, `--forge <task>` | dispatch a task through Forge |
| `-a`, `--agent <name>` | agent to answer (`--will <name>` is an alias) |
| `-e`, `--effort <1-10>` | effort level. Higher is deeper and slower |
| `-s`, `--safety <level>` | `unrestricted`, `casual` or `professional` |
| `--private` | keep the prompt out of logs and training capture |
| `-i`, `--image <path>` | attach an image. Repeatable |
| `--gateway [url]` | thin-client mode against a gateway (default `https://gateway.aitherium.com`). Forces raw inference |
| `--inference-mode <mode>` | `auto`, `genesis` or `raw` |
| `--deepseek [variant]` | talk straight to DeepSeek (`flash`, `reasoner` or a model id) |
| `--kimi`, `--moonshot [variant]` | talk straight to Moonshot (`k3`, `max` or a model id) |
| `-p`, `--print [prompt]` | headless: read the prompt from the argument and/or stdin, print the answer, exit |
| `--output-format <fmt>` | `text` (default), `json` or `stream-json` |
| `--json` | shorthand for `-p --output-format json` |
| `-C`, `--continue` | resume the most recent session |
| `--resume <id>` | resume a specific session (`--session <id>` is an alias) |
| `--login` | device-flow sign-in before starting |
| `--key <token>` | authenticate with an API key |

Inside a message, `@agent_name` at the start routes that one message to the
named agent.

## Subcommands

| subcommand | what it does |
|---|---|
| `awsh login` / `awsh logout` / `awsh whoami` | sign in with the device flow, clear the local profile, or show the identity the requests actually carry |
| `awsh init <pwsh\|powershell\|bash\|zsh>` | print the omnibox hook for a shell profile |
| `awsh init terminal` / `awsh init terminal-wrap` | Windows: install the hook, or a daemon-backed Claude Code tab profile, into Windows Terminal |
| `awsh setup` | run the install steps and check each one, printing a verdict per step |
| `awsh doctor` | Windows: measure how long a command miss takes to resolve, and name the `PSModulePath` entries that slow it |
| `awsh packs` (or `brains`) | list brain packs and whether each is usable |
| `awsh <pack>` | launch the shell with that brain pack (see [plugin-development.md](plugin-development.md)) |
| `awsh components [open <id>] [--json]` | show the platform components and their health, or open one's UI |
| `awsh rc [--node-class laptop] [--once]` | enrol this machine and hold the link, so its sessions show up in the web cockpit |
| `awsh connect` (or `ssh`) | connect to a remote node's shell |

## Built-in slash commands

This is the offline roster from `commands.json`: exactly the handlers built
into `src/commands.ts` that are registered as `COMMANDS['name']`. When awsh
can reach a backend, it adds that backend's commands at startup, and `/help`
lists the combined set. Tab completes the names.

| command | aliases | group | description |
|---|---|---|---|
| `/artifacts` |  | core | List all artifacts produced in this session |
| `/briefs` | `/b` | shell | List and read executive briefs (session closing summaries) |
| `/calendar` | `/cal` | core | Manage calendar events |
| `/cd` |  | core | Change working directory (set project path) |
| `/claude` |  | core | Hand a task to a scoped Claude Code subagent (adk runner) |
| `/command` | `/do` | core | Send text to the awdesk Command agent and print its reply |
| `/compose` | `/agent-new` | agents | Compose a new custom agent interactively |
| `/compute` | `/fabric` | ops | Manage federated compute fabric (discover/backends/nodes/scale/status) |
| `/desk` | `/persona` | core | Control the awdesk desktop overlay (avatar, tray, decision cards) |
| `/dev` |  | core | Manage dev environments (sandbox + AI agent) |
| `/docker` | `/dc` | ops | Manage Docker containers (up/down/status/build/restart/logs/ps/recover) |
| `/escalate` |  | core | Manage escalation proposals and config |
| `/feedback` |  | core | Submit feedback on your agent experience |
| `/fleet` |  | ops | Fleet refresh - rebuild all lib-baking Python images + safe rolling recreate |
| `/get` |  | core | Download an artifact by number or "all" (from /artifacts list) |
| `/ide` |  | core | Open ForgeIDE in browser (optionally for a sandbox session) |
| `/imagine` | `/draw`, `/gen` | core | Generate an image from a prompt |
| `/ingest` |  | core | Universal ingestion - ingest a URL or file into any agent |
| `/install` |  | core | Full AitherOS sovereign install - auth, Docker, pull, boot, extensions |
| `/lockbox` | `/lb` | security | Manage private prompts stored in Strata lockbox |
| `/mail` | `/email` | core | Manage email inbox and sending |
| `/monitor` | `/mon` | agents | Show real-time agent performance metrics |
| `/notebook` | `/nb` | agents | Create, run, or list agent notebooks |
| `/obsidian` |  | core | Install or link the AitherOS Obsidian plugin into a vault |
| `/onboard` |  | core | Unified onboarding for codebases, repos, and knowledge directories |
| `/pool` |  | core | LLM pool management - check status or reset stuck slots |
| `/preview` |  | core | List active preview containers or open one in browser |
| `/products` | `/prod` | ops | Manage standalone product instances |
| `/publish` |  | core | Publish content via Vera (blog, social) |
| `/report-bug` | `/bug` | core | Report a bug with structured details |
| `/research` |  | core | Launch a research task via Lyra (Forge dispatch) |
| `/resume` | `/resume-all` | shell | Reopen the coding sessions you had open, on a backend you choose |
| `/sandbox` |  | core | Manage sandbox sessions (list, create, stop, exec) |
| `/scaffold` |  | products | Scaffold a new product and deploy it to a subdomain (init, deploy, list) |
| `/scope` |  | core | AitherScope - codebase visualization and analysis |
| `/sessions` |  | shell | List or inspect saved session traces |
| `/storage` |  | core | Storage inventory: nodes, drives, diff, proposals, ledger, policy |
| `/support` |  | core | Open support page or show support options |
| `/tool-scope` | `/scope` | security | View or modify workspace tool scoping |
| `/will` |  | core | Manage Will policies (autonomous behavior directives) |
| `/workspace` |  | core | Manage workspaces and project contexts |

The core table in `src/commands.ts` also always has these, whatever the
backend: `/help`, `/login`, `/logout`, `/whoami`, `/model`, `/chats`,
`/export`, `/copy`, `/tokens`, `/rewind` and `/compact`. The REPL itself
handles `/deepseek`, `/kimi`, `/gui` and `/password` (the last two only inside
a pack that declares an app), plus `exit` and `quit`. A launched pack adds its
own `commands:`.

## Headless output

`-p` with `--output-format json` writes one JSON object to stdout:

```json
{
  "ok": true,
  "answer": "...",
  "model": "deepseek-chat",
  "agent": "aither",
  "session_id": "6f1c...",
  "tools": [],
  "tokens": 412
}
```

`errors` (an array of strings) appears only when something failed. If the
request itself fails, the object is `{"ok": false, "error": "...",
"session_id": "..."}`.

`--output-format stream-json` writes one JSON object per line, one per backend
event (`session_start`, `token`, `tool_call`, `tool_result`, `answer`,
`complete`, `error`, and so on). Treat the stream as ended when stdout closes.

The exit code is `0` on success and `1` on error. Subcommands that check
something (`setup`, `doctor`) exit `2` when they could not reach a verdict,
which is not the same as passing.
