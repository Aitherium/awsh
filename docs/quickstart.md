# awsh quickstart

This takes about five minutes. You need awsh installed first; see
[installation.md](installation.md).

## 1. Ask a question

```bash
awsh "what does this error mean: EADDRINUSE 127.0.0.1:8001"
```

When you give awsh a message, it answers once and exits. When you give it
nothing, it opens the interactive shell:

```bash
awsh
```

Each line you type in the shell goes one of three ways:

| you type | what happens |
|---|---|
| `/help` | a slash command, run locally |
| `!git status` | a shell escape, run by PowerShell 7 (`pwsh`, which must be on `PATH`); `!!` repeats the last one |
| anything else | a question for the backend |

While an answer is streaming, you can type a correction and it steers the
same turn. `/` and `!` lines still run as commands while a turn is
generating. They are never read as steering text.

## 2. See which backend answered

awsh picks a backend in this order and prints the one it chose:

1. an endpoint you pinned (`--gateway`, `AITHER_API_URL`, or `api_url` in
   `~/.aither/shell.yaml`)
2. a local agent daemon on `127.0.0.1:9001`
3. a local Genesis on `127.0.0.1:8001`
4. the public cloud gateway (`https://gateway.aitherium.com`), which needs
   you to sign in

If you have no local stack and no account, use a provider key directly:

```bash
export DEEPSEEK_API_KEY=...        # your own key; awsh never stores it
awsh --deepseek "explain this regex: ^(\w+):\s*(.+)$"
```

## 3. Sign in (cloud only)

```bash
awsh login        # device flow: open the printed link and confirm the code
awsh whoami       # the identity your requests actually carry
```

## 4. Use it from scripts

```bash
git diff | awsh -p "review this diff" --output-format json
```

`-p` reads the prompt from its argument, from piped stdin, or both. It prints
one answer and exits 0 on success or 1 on error. The JSON format is described
in [api-reference.md](api-reference.md#headless-output).

## 5. Keep the conversation

```bash
awsh --continue          # resume the most recent session
awsh --resume <id>       # resume a specific one
```

Transcripts live in `~/.aither/sessions`.

## 6. Answer mistyped lines in your own shell (optional)

```bash
eval "$(awsh init bash)"                          # bash / zsh
awsh init pwsh | Out-String | Invoke-Expression   # PowerShell
```

After this, typing a question where a command would go gets you an answer
instead of `command not found`. Add the line to your profile to keep it.

## Next

- [configuration.md](configuration.md): every setting and environment variable
- [plugin-development.md](plugin-development.md): add a brain pack with its own commands
- [troubleshooting.md](troubleshooting.md): what the common errors mean
