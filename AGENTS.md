# awsh for agents

Read this if you are an agent (or a human) editing this package. Short on
purpose: gotchas, then pointers.

## What this is

npm package **`@aitherium/awsh`**; bins `awsh`, `aither`, `aither-shell` all
run `dist/main.js`. TypeScript, ESM, Node >= 18.

## Build and test

| command | what it runs |
|---|---|
| `npm run build` | `sync-version --check && check-spinner-import && tsc` — two preflights can fail it before `tsc` runs |
| `npm test` | `node --import tsx --test "test/**/*.test.ts"` — `node:test`, NOT jest/vitest |
| `npm run test:tui` | the timeline/controller/wide-chars/verdict-model suites |
| `npm run version:check` | version parity between the files that carry it |

## Behaviour worth knowing before you edit

- **Backend ladder** (`src/backend-resolver.ts`): a pinned endpoint
  (`--gateway` / `AITHER_API_URL` / config `api_url`) is honoured verbatim and
  DISABLES the ladder → local agent daemon `127.0.0.1:9001` → local gateway
  `127.0.0.1:8001` → cloud. A switch is reported, never silent.
  `AITHERSHELL_USE_ADK=0` skips the daemon.
- **Input dispatch** (`src/repl.ts`): `/…` opens a command, `!…` runs in
  PowerShell 7 — both local, both work mid-generation. Anything else typed
  during a generation STEERS the running turn; it is not queued.
- **Context files**: `src/context-loader.ts` reads `CLAUDE.md` / `AGENTS.md` /
  `AITHER.md` + `.claude/rules/*.md` on `/project switch`. `getWorkspaceContext()`
  in `src/workspace.ts` has NO caller — a dead path; do not fix prompt bugs there.
- **The model prompt** is the pack's `system_prompt` sent as `system_additions`
  (a list) in `src/client.ts`; `test/pack-prompt-reaches-model.test.ts` pins it.

## Releasing

Publishing happens in this repo's own `npm-publish` workflow via OIDC trusted
publishing — no long-lived token. See `README.md`.

## Read next

`README.md`
