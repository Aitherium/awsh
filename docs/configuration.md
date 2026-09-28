# Configuring awsh

Settings come from three places. A command-line flag wins over an environment
variable, and an environment variable wins over the config file. Every name
on this page appears in `src/config.ts` or `src/main.ts`, and a test fails if
the page names one that does not.

## The config file: `~/.aither/shell.yaml`

The file is optional and flat: one `key: value` per line, with no nesting.
Quotes around a value are stripped, and the file may use CRLF line endings.

```yaml
api_url: https://genesis.example.internal:8001
default_agent: aither
model: deepseek-chat
inference_mode: auto
```

| key | meaning |
|---|---|
| `api_url` | backend base URL (Genesis or an ADK server). `genesis_url` is the legacy spelling |
| `gateway_url` | thin-client mode: sets the API, MCP and LLM URLs to this gateway and forces raw inference |
| `mcp_url` | MCP tool gateway base URL |
| `llm_url` | OpenAI-compatible `/v1` base for raw inference |
| `identity_url` | device-login service (default `http://127.0.0.1:8115`) |
| `inference_mode` | `auto`, `genesis` or `raw` (see below) |
| `default_agent` | agent that answers when no `@agent` or `--agent` is given |
| `model` | model override |
| `<role>_url`, `<role>_model`, `<role>_key_env` | per-role provider, where `<role>` is `orchestrator`, `reasoning` or `perception`. `_key_env` names the environment variable that holds the key; the key itself never goes in this file |

A value in `api_url`, `genesis_url` or `gateway_url` pins the endpoint (so
does the matching environment variable or `--gateway`). A pinned endpoint is
used exactly as given. Only the unpinned default, local Genesis, can fail
over to the cloud automatically.

## Environment variables

| variable | meaning |
|---|---|
| `AITHER_API_URL` | backend base URL (`AITHER_GENESIS_URL` is the legacy alias) |
| `AITHER_GATEWAY_URL` | same as `gateway_url` |
| `AITHER_MCP_URL` | same as `mcp_url` |
| `AITHER_LLM_URL` | same as `llm_url` |
| `AITHER_IDENTITY_URL` | same as `identity_url` |
| `AITHER_INFERENCE_MODE` | same as `inference_mode` |
| `AITHER_AGENT` | same as `default_agent` |
| `AITHER_MODEL` | same as `model` |
| `AITHER_CLOUD_URL` | cloud failover edge (default `https://gateway.aitherium.com`) |
| `AITHER_CLOUD_MCP_URL` | cloud MCP edge (default `<cloud>/mcp`) |
| `AITHER_CLOUD_IDENTITY_URL` | cloud device-login edge (default `https://idp.aitherium.com`) |
| `AITHER_REQUIRE_AUTH` | set to `1` to refuse the automatic local root profile and require a real sign-in |
| `AITHER_ORCHESTRATOR_URL`, `AITHER_ORCHESTRATOR_MODEL`, `AITHER_ORCHESTRATOR_KEY`, `AITHER_ORCHESTRATOR_KEY_ENV` | per-role provider, overriding the file keys. Same pattern for `REASONING` and `PERCEPTION` |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` | provider used by `--deepseek` (`AITHER_DEEPSEEK_API_KEY` also works) |
| `MOONSHOT_API_KEY`, `MOONSHOT_BASE_URL` | provider used by `--kimi` (`KIMI_API_KEY` and `AITHER_MOONSHOT_API_KEY` also work) |
| `AITHER_TUI` | `1` opens the full-screen three-pane TUI. The default is the line-mode shell |
| `AITHER_STEER` | `1` adds the fixed bottom steering bar (costs terminal scrollback) |
| `AITHEROS_ROOT` | checkout root used to find brain packs and the fleet CA chain |
| `AWSH_PACKS_DIR` | an extra pack root, searched first |
| `AWSH_DEFAULT_AGENT` | serving agent used when nothing else names one |

## Inference modes

| mode | path |
|---|---|
| `auto` (default) | Genesis `/chat/stream` when it is reachable (tools, memory, effort), otherwise the gateway's raw `/v1/chat/completions` |
| `genesis` | always the Genesis pipeline |
| `raw` | always raw model inference at `llm_url`. This is the portable path, because it works anywhere with internet access and a key |

`--gateway` and `gateway_url` set `raw` unless you also pass
`--inference-mode`.

## Direct providers

`--deepseek [flash|reasoner|<model>]` and `--kimi [k3|max|<model>]` send
requests straight to that provider's OpenAI-compatible API, using that
provider's key. Nothing goes through the AitherOS pipeline, and the endpoint
is pinned, so it never fails over.

## Credentials

- `~/.aither/session-bearer` is the bearer every request carries.
  `awsh whoami` resolves that bearer, not the cached profile.
- `~/.aither/auth.json` is the profile store shared with the Python `adk`
  CLI. `awsh login` writes it and `awsh logout` clears the local profile.
- `--key <token>` authenticates with an API key for that run.

Keys never go in `shell.yaml`. Put them in an environment variable and name
that variable with `<role>_key_env`.

## TLS

At startup awsh looks for the fleet CA chain at `~/.aither/tls/ca-chain.pem`,
then at `$AITHEROS_ROOT/Library/Data/tls/ca-chain.pem`. The first one it
finds becomes `NODE_EXTRA_CA_CERTS`. When awsh fails over to a public edge, it
restores strict certificate verification before it sends any credential.

## Shell integration (omnibox)

`awsh init <pwsh|powershell|bash|zsh>` prints a hook for your shell's profile.
Once the hook is installed, a line your shell does not recognise is sent to
`awsh ask --omnibox`. On Windows, `awsh init terminal` edits the Windows
Terminal profile directly and reads the file back to confirm the edit landed.
`awsh doctor` measures whether a command miss resolves fast enough for the
hook to be worth installing.
