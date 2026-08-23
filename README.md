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
npm i -g awsh
awsh
```

Node 20+. It runs on its own; it does not need an account, and it does not need
our cloud — point it at any agent-shaped backend, including one on localhost.

## How a line is routed

Three cases, decided before anything runs, so you always know which one you are in:

| you type | what happens |
|---|---|
| `/models` | a **slash command** — dispatched locally, 74 of them |
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

## The commands

74 of them. `/commands` lists every one, `/help <name>` explains one, and Tab
completes them.

| | |
|---|---|
| `/models` `/pool` `/compute` `/node` | what is serving you, and on whose hardware |
| `/fleet` `/docker` `/deploy` `/routines` | the machines and what runs on them |
| `/codegraph` `/repowise` `/explore` `/review` | the code you are standing in |
| `/memory` `/context` `/ingest` `/research` | what it knows and what you gave it |
| `/mail` `/inbox` `/cal` `/tasks` | the day around the work |
| `/imagine` `/generate` `/notebook` | making things |
| `/escalate` `/approve` `/expedition` | when a human has to decide |

## Where it sits

`awsh` is the front door of the **Aither World** — the same tools an agent uses,
in the place you were already typing. It composes with
[awdk](https://github.com/Aitherium/awdk) (the agent runtime it can talk to),
[awfind](https://github.com/Aitherium/awfind) (search that is not one vendor's
index) and [awbrowse](https://github.com/Aitherium/awbrowse) (a page it can
actually read). None of them are required.

## Licence

**BUSL-1.1.** Free to install, run and modify for your own use. It is not
Apache-2.0 like most of the family, and the family list will keep saying so
rather than letting you find out at adoption time.

The published artifact is the binary: `npm i -g awsh`. `@aitherium/shell-cli` is
the old name and still works — it installs `awsh` for you.
