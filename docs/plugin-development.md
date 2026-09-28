# Extending awsh: brain packs

awsh has no in-process plugin API, so there is no JavaScript to load and no
hook to register. You extend it with data. A **brain pack** is a directory
holding a manifest. `awsh <pack>` starts the shell with that pack's persona,
agent identity and commands, the way `fish` and `bash` are the same terminal
with different opinions. Adding a pack does not need a release.

The code that reads packs is `src/packs.ts`. The tests are in `test/` next to
it.

## Where awsh looks

The pack roots are searched in this order. The first root that has a given
name wins, and `awsh packs` shows which root each pack came from:

1. `$AWSH_PACKS_DIR`, when it is set
2. `awdk/adk/packs/` and `AitherOS/Library/packs/` under `$AITHEROS_ROOT`, or
   under the current directory when that variable is unset
3. the same two directories under the checkout that awsh itself was built
   from, found by walking up from the running module

Directory names starting with `.` or `__` are skipped.

## The manifest

In each pack directory, awsh reads the first of `brain_pack.yaml`, `pack.yaml`
or `<name>.yaml` that exists. The parser is deliberately small. It reads
top-level `key: value` pairs and `key: |` block scalars, plus one `commands:`
list, and it ignores everything else. It does not guess at nested structure.

```yaml
app_name: Release Captain
identity: aither
system_prompt: |
  You run release checklists. Before you say a release is done, ask for the
  tag, the changelog entry and the SHA256SUMS digest.

commands:
  - name: checklist
    description: Open the release checklist
    url: https://example.invalid/release-checklist
  - name: sums
    description: Print the digests of the local build
    run: sha256sum dist/*
```

| key | effect |
|---|---|
| `system_prompt` | **required.** Sent as the first system message. A pack without one is listed as "not usable" and is never launched with an empty brain |
| `app_name` (or `name`) | title shown as the shell's wordmark |
| `identity` | agent identity, sent as `persona` on the Genesis path so the backend selects a configured agent |
| `commands` | slash commands this pack adds (see below) |
| `app_script`, `app_url` | the pack's full app: the script that starts it, and the URL that is polled to prove it came up. When `app_script` is set, `/gui` is offered |
| `app_secret_file` | file holding the app's password. When it is set, `/password` is offered |
| `app_llm_port`, `app_llm_model`, `app_llm_key_file` | backend for the app's inference proxy |
| `app_sidecar_script`, `app_search_port`, `app_search_service` | a companion process started next to the app |

## Pack commands

Each entry under `commands:` becomes `/<name>` while the pack is active, and
Tab completes it.

- `url:` opens the address in the default browser and also prints it.
- `run:` runs the string through your shell, with the terminal attached.
- An entry with neither is dropped when the manifest is parsed. A menu item
  that does nothing is worse than no item, because the user cannot tell it is
  broken.

Inside the pack, pack commands are checked **before** the built-in slash
commands. A pack can therefore take over a name such as `/checklist` without a
later built-in hiding it.

## Trying it

```bash
mkdir -p ~/my-packs/release-captain
$EDITOR ~/my-packs/release-captain/brain_pack.yaml
AWSH_PACKS_DIR=~/my-packs awsh packs            # it is listed and marked usable
AWSH_PACKS_DIR=~/my-packs awsh release-captain  # launch it
```

`awsh <word>` launches a pack only when the word exactly matches the name of a
usable pack. Anything else, such as `awsh what is release-captain`, is still a
question.

## Commands from the backend

Beyond the pack, the slash-command list grows at runtime. At startup the REPL
asks Genesis and the MCP gateway for their commands (`loadDynamicCommands()`
in `src/command-registry.ts`). The bundled `commands.json` is only the offline
fallback: it lists exactly the handlers built into `src/commands.ts`, and it is
generated from that handler table. Do not edit it by hand.

For tools that agents use as well as people, build an MCP tool or an ADK agent
(`awdk/`), not a shell-only command.
