# Troubleshooting awsh

Each heading below is a message awsh prints, or a symptom you would see. Look
up the message you got.

## `Backend not reachable at <url>`

Nothing answered at the endpoint awsh chose. Check which endpoint that was:
it is printed at startup, and it comes from the order in
[configuration.md](configuration.md#the-config-file-aithershellyaml).

- If the endpoint was pinned (`AITHER_API_URL`, `api_url`, `--gateway`), awsh
  does **not** fail over. A pin is honoured even when the host is down. Unset
  the pin, or point it somewhere that is up.
- For a local stack, start either Genesis (`127.0.0.1:8001`) or an ADK agent
  (`adk run --identity <agent>`, which listens on `127.0.0.1:9001`).
- With no stack at all, use `--gateway` with a key, or a direct provider
  (`--deepseek`, `--kimi`).

## `Cloud gateway requires sign-in — run /login`

awsh failed over to the public gateway, and you are not signed in. Run
`awsh login`, or start a local backend. If the message says that the local
agent daemon **was still booting**, you do not need to sign in: the daemon was
seconds from answering, so retry in a moment and the free local backend will
take the turn.

## `(no response)` or an HTML page instead of an answer

The URL you configured serves a web page, not an OpenAI-compatible `/v1`.
Point `llm_url` or `--gateway` at a host that answers
`POST /v1/chat/completions`. The default cloud edge is
`https://gateway.aitherium.com`.

## `~/.aither/shell.yaml` seems to be ignored

- Keys must sit at the top level (`key: value`), and a nested block is
  skipped. The key names are listed in [configuration.md](configuration.md).
- An environment variable overrides the same key in the file. Check `env | grep AITHER_`.
- CRLF line endings are supported. Builds before the CRLF fix dropped every
  line of a Windows-written file, so upgrade if you are on one.

## `awsh whoami` shows a different user than you expected

`whoami` resolves `~/.aither/session-bearer`, the credential every request
carries, not the cached profile in `auth.json`. If the two disagree, the
bearer is the identity the backend sees. Run `awsh login` again to replace
it.

## TLS errors against a private fleet

Put the fleet's CA chain at `~/.aither/tls/ca-chain.pem`, or set
`AITHEROS_ROOT` so that `Library/Data/tls/ca-chain.pem` is found. awsh never
switches verification off for a public host: failover to a public edge
restores strict TLS.

## `awsh <name>` answered a question instead of launching a pack

A pack launches only when the word **exactly** matches a pack whose manifest
has a `system_prompt`. Run `awsh packs`: a pack marked "not usable" has no
prompt, and one that is missing is not in any pack root. If `AITHEROS_ROOT`
points at an old checkout, set `AWSH_PACKS_DIR`, or unset the stale variable.
See [plugin-development.md](plugin-development.md).

## A pack command does nothing

An entry under `commands:` with neither `run:` nor `url:` is dropped when the
manifest is parsed, so it never appears. If it appears but fails, the `run:`
string runs through your shell: try it by hand first.

## The omnibox hook makes every typo slow (Windows)

Run `awsh doctor`. It times how long a command miss takes to resolve and names
the `PSModulePath` entries that cause the delay. Exit `0` means the hook is
worth installing, `1` means it is not yet (with a remedy), and `2` means the
probe could not run, which is **not** a pass.

## A profile edit "succeeded" but the hook never loads (Windows)

Controlled Folder Access can block writes to `$PROFILE` while reporting
success. Use `awsh init terminal`: it installs through the Windows Terminal
settings and reads the file back to prove the edit landed. Then open a new
tab.

## Headless mode hangs in a script

`-p` waits for stdin when nothing is piped and no prompt is given. Pass the
prompt as an argument, or pipe something in: `echo "" | awsh -p "..."`.
With `--output-format json`, check `ok` rather than parsing the text, and
treat exit code `1` as a failure.

## Reporting a bug

Use `/report-bug` (or `/bug`) from the shell, or `/feedback`. Include
`awsh --version` and the endpoint printed at startup.
