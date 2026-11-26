# awsh — your terminal answers you

A shell has exactly one response to a line it does not recognise:

```
$ how do I rotate this cert without dropping the tunnel
bash: how: command not found
```

So you open a browser, and you lose the directory you were in, the environment
you had loaded, and the session you were already halfway through — when
everything needed to answer you was right there on the machine.

`awsh` is a terminal where that line is a question instead of a mistake.

```bash
npm i -g @aitherium/awsh
awsh up      # boot local harness daemons + wire Antigravity & Claude Code (paired with awdk 4.0)
awsh         # open the full-screen cockpit with your live terminal avatar
```

Node 20+. It runs on its own; it does not need an account, and it does not need
our cloud — point it at any agent-shaped backend, including one on localhost.

## How a line is routed

Three cases, decided before anything runs, so you always know which one you are in:

| you type | what happens |
|---|---|
| `/models` | a **slash command** — dispatched locally, 133 of them |
| `!git status` | a **shell escape** — straight through to your shell |
| `why is this container unhealthy` | a **question** — answered by the backend you chose |

The routing is not a guess made after the fact. `/` and `!` are dispatched
locally **even while a generation is running**, so a command never gets swallowed
as steering text — and anything else typed during a generation **steers it**
rather than queuing behind it. That is the part people notice: you do not have to
wait for a wrong answer to finish before correcting it.

## Steering, not waiting

```
> plan the migration for the payments service
  ...thinking, streaming...
> actually assume postgres 16, not 14        ← lands in the SAME turn
> cancel                                      ← or stop it outright
```

## Backends

`awsh` resolves where to think, in this order, and tells you which it picked:

1. an endpoint you pinned (`--gateway`, `AITHER_API_URL`, or the config file)
2. a local agent daemon on `127.0.0.1:9001`
3. a local gateway on `127.0.0.1:8001`
4. whatever cloud endpoint you are logged into

A pinned endpoint always wins. Nothing is silently substituted: if the fast local
path is unreachable it says so rather than quietly falling back and getting
slower for reasons you cannot see.

## The daily driver (awsh 2.0, paired with awdk 4.0)

| | |
|---|---|
| `awsh` | full-screen TUI cockpit with a live animated terminal avatar docked top-right (auto-detects Kitty / Ghostty / WezTerm, iTerm2, Sixel, or 24-bit area-averaged half-blocks; `AWSH_AVATAR=0` opts out; `AITHER_TUI=0` for line mode) |
| `awsh up` | one-command local harness bootstrap (`adk harness up`: `hookd`, `awsh` :8362, `aw-hub`, Antigravity & Claude Code auto-wiring) + avatar readiness |
| `awsh agent [name]` | persistent tool-using agent session owned by the harness daemon (`--harness antigravity\|claude\|codex\|gemini\|adk`, default `claude`). Rerun to reattach; inside: `/harness`, `/avatar`, `/status`, `/cards`, `/board`, `/agents`, Ctrl+C interrupts |
| `awsh avatar [show\|list\|use\|protocol\|crop\|demo\|sync]` | render & configure live terminal avatars (`aither`, `blob`, `bun`, `bunny`, `pip` bundled out of the box, plus `~/.aither/avatars/`) |
| `awsh antigravity [setup\|doctor\|sessions\|spawn\|steer]` | 2-way Google Antigravity + Aither harness bridge |
| `awsh sessions live` | unified cockpit over every active agent tab & daemon session (`Ctrl+S` inside TUI lets you press `i` to `steer`, `focus`, `new`, or `kill` inline) |
| `awsh status` | fleet health counted from the container runtime (docker, then podman), the Atlas board, and the decision cards waiting on you -- answer one inline |
| `awsh agents [spawn <name> "<prompt>"]` | the agent roster and live agent sessions; spawn Demiurge, Lyra, Atlas, ... in the background |
| `awsh cards [answer <n> <option> [note]]` | waiting decision cards, numbered most-urgent first |

The harness daemon is found by probing: `AITHER_HARNESS_URL`, then `127.0.0.1:8362`,
then (inside WSL) the fleet bridge `10.89.0.1:8362`, with the bearer from
`~/.aither/harness_token` or the one Windows profile that has it. MCP tools use the
configured gateway, else the local one at `127.0.0.1:8182` with `~/.aither/session-bearer`.
Inside WSL the host daemon gets Windows paths: `/mnt/c/x` is sent as `C:\x`, and a
Linux-only directory such as `/root` runs in the daemon's default directory.

### Installing a build the registry does not have yet

```bash
npm ci && npm run build && npm pack          # in cli/: makes aitherium-awsh-<version>.tgz
npm install -g ./aitherium-awsh-<version>.tgz
awsh --version
```

## The commands

133 of them. `/help` lists every one, `/help <name>` explains one, and Tab
completes them.

| | |
|---|---|
| `/models` `/pool` `/compute` `/node` | what is serving you, and on whose hardware |
| `/fleet` `/docker` `/deploy` `/routines` | the machines and what runs on them |
| `/spend` | cloud LLM spend: `/spend 7d` totals, per provider/model, top callers, DeepSeek balance; the status bar shows `$X.XX/24h` |
| `/board` | Atlas' issue board (stage, age, PR, thread per issue; `/board --counts` for just the counts) -- the same snapshot as the desk, Veil `?tab=atlas` and the Discord pin |
| `/ops` `/backups` `/backup` | the platform control plane: `aither ops backups verify` is a dry run; `--apply` starts it, `--agent genesis` hands it to Genesis |
| `/codegraph` `/repowise` `/explore` `/review` | the code you are standing in |
| `/memory` `/context` `/ingest` `/research` | what it knows and what you gave it |
| `/mail` `/inbox` `/cal` | the day around the work |
| `/imagine` `/generate` `/notebook` | making things |
| `/escalate` `/approve` `/expedition` | when a human has to decide |

## Docs

[Installation](docs/installation.md) · [Quickstart](docs/quickstart.md) ·
[Configuration](docs/configuration.md) · [Brain packs](docs/plugin-development.md) ·
[Reference](docs/api-reference.md) · [Troubleshooting](docs/troubleshooting.md)

## awsh in the harness

<!-- aither-harness:start GENERATED from ecosystem.yaml `harness:` by gen_brick_map.py. Edits between these markers are overwritten; change the registry. -->
> **`awsh` is part of `awharness` — the super agent harness.** One name for the kit, the shell and the bricks an agent works with, taken together. It is a harness that sits above other harnesses: the shell drives Google Antigravity, Claude Code, Codex and the rest as real products, and the bricks give every one of them the same memory, jobs, leases, permits and tools.
>
> **Today:** `adk harness up` brings up the local harness daemons (`hookd`, `awsh`, `aw-hub`), checks installed bricks (`adk harness parts`), and auto-wires detected coding agents (`adk antigravity setup`, `adk claude setup`). Each optional brick still installs on its own line (`pip install awdk`, `npm i -g @aitherium/awsh`).
>
> **Planned, not built:** One umbrella installer package that installs every composed brick together under the `awharness` name. Nothing by that package name is published yet.
>
> The other 10 composed bricks: `awdk` `awskills` `awm` `awgraph` `awrun` `awrise` `awgit` `awpermit` `awrelay` `awnode`. All 102 bricks, in layers: https://aitherium.github.io/#map
<!-- aither-harness:end -->

`awsh` is the part you type into. What it adds to a terminal that only talks to
one model, and where each piece is:

| | check it |
|---|---|
| The session belongs to a daemon, not to this window: close the terminal, rerun in the same directory, and you are back in it | `awsh agent`, then `awsh agent --resume <id>`; the daemon is `adk harness serve` on `127.0.0.1:8362` |
| The same door opens other agent products, not only ours | `adk harness harnesses` lists the ones this machine can drive |
| Agents you started in the background are visible and answerable | `awsh agents`, `awsh cards` |
| What you type while it is generating steers the same turn | see "Steering, not waiting" above |

`adk harness parts` (from `awdk`) prints which of the composed bricks this machine
has and the install line for each one it lacks. It installs and starts nothing.

## Where it sits

`awsh` is the front door of the **Aither World** — the same tools an agent uses,
in the place you were already typing. It composes with
[awdk](https://github.com/Aitherium/awdk) (the agent runtime it can talk to),
[awfind](https://github.com/Aitherium/awfind) (search that is not one vendor's
index) and [awbrowse](https://github.com/Aitherium/awbrowse) (a page it can
actually read). None of them are required.

## Community

Questions, ideas and show-and-tell go on the project boards at
https://app.aitherium.com/forum (the `awsh` board is this project's; reading needs no account).
Bugs go to [GitHub issues](https://github.com/Aitherium/awsh/issues).

## Licence

**BUSL-1.1.** Free to install, run and modify for your own use. It is not
Apache-2.0 like most of the family, and the family list will keep saying so
rather than letting you find out at adoption time.

The published npm package is `@aitherium/awsh` — it installs the `awsh`, `aither`, and `aither-shell` binaries along with bundled animated terminal avatars (`assets-bundled/`).
