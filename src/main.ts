#!/usr/bin/env node
// Trust AitherOS internal TLS certs.
//
// Reality of the fleet's PKI: each internal service ships a SELF-SIGNED leaf
// (e.g. Identity at :8115 → subject==issuer CN=aitheros-identity, no SAN for
// 127.0.0.1). Those certs are NOT issued by ca-chain.pem and carry no loopback
// SAN, so NODE_EXTRA_CA_CERTS can never validate them — under Node, fetch() to an
// https-only internal service (Identity) fails cert/hostname verification and the
// status banner false-flags it DOWN even though it's up. (Bun ignores
// NODE_EXTRA_CA_CERTS entirely; its per-request `tls` opt is handled in the probe.)
//
// So: when the primary endpoint is a LOCAL/loopback fleet (the self-signed trust
// domain), disable verification. For a PUBLIC endpoint (idp/gateway.aitherium.com,
// real CA-issued certs) keep strict TLS — those validate normally and must stay
// protected against MITM. NODE_EXTRA_CA_CERTS is still set when present (harmless,
// and helps any service that IS chain-issued).
import { existsSync } from 'fs';
import { join, basename } from 'path';
const _caChainPaths = [
  join(process.env.HOME || process.env.USERPROFILE || '', '.aither', 'tls', 'ca-chain.pem'),
  join(process.env.AITHEROS_ROOT || '', 'Library', 'Data', 'tls', 'ca-chain.pem'),
  '/app/AitherOS/Library/Data/tls/ca-chain.pem',
];
const _caChain = _caChainPaths.find(p => p && existsSync(p));
if (_caChain) process.env.NODE_EXTRA_CA_CERTS = _caChain;

const _isPrivateHost = (url: string): boolean => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local') || h.endsWith('.internal');
  } catch { return true; } // unparseable → assume local dev
};

// Gather EVERY endpoint the shell may actually talk to — env vars AND the
// saved ~/.aither/shell.yaml (where the endpoint usually lives; env is rarely
// set). The previous code looked only at env vars, so a config-file endpoint
// pointed at a PUBLIC host (api_url: mcp.aitherium.com, identity_url:
// idp.aitherium.com) fell through to the 127.0.0.1 default → "loopback" → the
// process-global NODE_TLS_REJECT_UNAUTHORIZED=0 disabled cert verification for
// EVERY https request, incl. the PAT sent to those public edges (MITM-exposed).
const _shellYaml = join(process.env.HOME || process.env.USERPROFILE || '', '.aither', 'shell.yaml');
const _fileUrls: string[] = [];
if (existsSync(_shellYaml)) {
  try {
    // MUST be /\r?\n/ — see config.ts. With a bare '\n' split, the trailing '\r'
    // defeated the '$' anchor, _fileUrls came back EMPTY, the fallback below made
    // the endpoint set look like pure loopback, and TLS verification was disabled
    // process-wide — the exact MITM exposure this block exists to prevent.
    for (const line of readFileSync(_shellYaml, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^(\w*url):\s*(.+)$/i);
      if (m) _fileUrls.push(m[2].trim().replace(/^["']|["']$/g, ''));
    }
  } catch { /* ignore bad config */ }
}
const _endpoints = [
  process.env.AITHER_API_URL, process.env.AITHER_GENESIS_URL,
  process.env.AITHER_GATEWAY_URL, process.env.AITHER_CLOUD_IDENTITY_URL,
  ...(_fileUrls.length ? _fileUrls : ['http://127.0.0.1:8001']),
].filter((u): u is string => !!u);

// Relax TLS ONLY when the ENTIRE endpoint set is the private self-signed trust
// domain. If ANY configured endpoint is public (a real CA-issued edge), keep
// strict verification so credentials to that edge are MITM-protected. A private
// self-signed SECONDARY under strict TLS at worst shows "down" in the banner
// (cosmetic) — never a credential leak. Explicit override always wins.
const _allPrivate = _endpoints.length > 0 && _endpoints.every(_isPrivateHost);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED == null && _allPrivate) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  // Node then screams a 3-line all-caps security warning as the FIRST thing the
  // user sees on every single launch — noise, and alarming out of context, since
  // this branch only runs when EVERY endpoint is the private self-signed trust
  // domain (a deliberate, scoped decision documented above). Swallow ONLY that
  // one warning; every other process warning still surfaces normally.
  //
  // removeAllListeners FIRST — this is what makes the suppression work. Node
  // prints warnings from its OWN default 'warning' listener, installed during
  // bootstrap; merely ADDING a listener does not replace it. Without this line the
  // TLS warning still printed AND every other warning printed TWICE (once by Node,
  // once by the handler below). Measured 2026-07-25: add-only → TLS warning still
  // shown + duplicated output; remove-then-add → TLS gone, others exactly once.
  process.removeAllListeners('warning');
  process.on('warning', (w: NodeJS.ErrnoException & { name?: string }) => {
    const msg = `${w?.name ?? ''} ${w?.message ?? ''}`;
    if (msg.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;   // ours, expected
    console.warn(`${w?.name ?? 'Warning'}: ${w?.message ?? String(w)}`);
  });
}
/**
 * AitherShell CLI — interactive terminal for AitherOS.
 *
 * Usage:
 *   aither-shell                     Interactive REPL
 *   aither-shell "question"          One-shot mode
 *   aither-shell -c status           Execute slash command and exit
 *   aither-shell -f "task"           Forge dispatch and exit
 *   aither-shell --help              Show help
 */

import chalk from 'chalk';
import { readFileSync } from 'fs';
import { extname } from 'path';
import { VERSION as SHELL_VERSION } from './version.js';
import type { ShellConfig } from './config.js';
import { loadConfig, setActiveConfig, deepseekProvider, kimiProvider, DEFAULT_AGENT} from './config.js';
import { resolveBackend } from './backend-resolver.js';
import { GenesisClient } from './client.js';
import { renderBanner, createStreamRenderer } from './renderer.js';
import { buildProbes, discoverLocalServices, probeHealth, pickServingModel } from './status-banner.js';
import { startRepl } from './repl.js';
import { installCrashReporter, setCurrentCommand } from './crash-reporter.js';
import { collectPositional } from './cli-args.js';
import {
  configureRemoteSync, recordTurn, loadSession, loadRemoteSession,
  mostRecentSessionId, buildContextSummary,
} from './session-store.js';

/** Read piped stdin as text (headless prompt body). Empty if attached to a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise<string>((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data.trim()); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // Safety: a non-TTY stdin that never closes (some pipes) must not hang the
    // process — if no EOF arrives quickly, resolve with whatever we have.
    setTimeout(finish, 1500);
  });
}

/** Resolve a --continue/--resume/--session target into a session id + transcript. */
async function resolveResume(
  client: GenesisClient, config: ShellConfig, mode: 'continue' | 'id', id?: string,
): Promise<{ sessionId: string; summary: string } | null> {
  let sid = mode === 'continue' ? mostRecentSessionId() : (id || null);
  if (!sid) return null;
  let entry = loadSession(sid);
  if (!entry) { try { entry = await loadRemoteSession(sid); } catch { entry = null; } }
  config.sessionId = sid;
  config.resumeSessionId = sid;
  config.resumed = true;
  return { sessionId: sid, summary: entry ? buildContextSummary(entry.messages) : '' };
}

// Install global crash reporter — catches uncaught exceptions/rejections,
// prompts user to send error report, creates GitHub issue automatically.
installCrashReporter();

/**
 * Read from package.json at runtime, never hardcoded.
 *
 * This was a hardcoded literal mirrored from package.json by
 * scripts/sync-version.mjs, and it drifted anyway. Measured 2026-08-23 against
 * the PUBLISHED package: source said 1.18.0, the built artifact reported
 * 1.18.2, and the published package.json said 1.18.3. THREE different answers
 * to "what version am I running".
 *
 * (No version literal appears in this comment on purpose: sync-version.mjs
 * matches `const VERSION = '...'` by regex, and a literal here would let the
 * check pass by matching PROSE while the real code carried none.)
 *
 * The reason a constant can never work here is that the release lane BUMPS the
 * version in CI (`prepare` resolves it, npm writes it), so the repo's copy is
 * stale by construction at the moment of publish. A comment asking a human to
 * keep two numbers in step is not a mechanism.
 *
 * `../package.json` is correct from BOTH layouts: dist/main.js -> package root
 * (published), and src/main.ts -> cli/ (dev, run through tsx).
 */
const VERSION = SHELL_VERSION;

async function main() {
  const args = process.argv.slice(2);

  // `--help` ANYWHERE in argv printed the global usage, so `aither <subcommand> --help` could
  // never reach a subcommand's own help — the flag was swallowed before dispatch. Subcommands
  // that print their own usage opt in here; everything else keeps the old behaviour exactly,
  // so this cannot regress a command that has no help of its own.
  const HELP_AWARE = new Set(['bonsai']);
  if ((args.includes('--help') || args.includes('-h')) && !HELP_AWARE.has((args[0] || '').toLowerCase())) {
    printUsage();
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`awsh ${VERSION}`);
    return;
  }

  // ── `awsh init <shell>` — emit the omnibox shell integration ──────────
  //
  // Deliberately CONFIG-FREE and NETWORK-FREE, and placed above loadConfig()
  // for that reason: this runs from a shell profile on every new terminal a
  // human opens. Anything slow here is a tax on opening a terminal, and
  // anything that can fail here is a profile that errors on every login.
  if (args[0] === 'init') {
    const { omniboxInitScript, INIT_SHELLS } = await import('./omnibox.js');
    const want = (args[1] || '').toLowerCase();

    // `awsh init terminal` -- the install of last resort, and on some machines
    // the ONLY one. Controlled Folder Access makes every $PROFILE path
    // unwritable while reporting success, so "add this line to your profile"
    // is advice that cannot be followed and cannot be seen to fail. This does
    // the edit and verifies it by reading the file back.
    if (want === 'terminal') {
      const { installIntoWindowsTerminal } = await import('./terminal-install.js');
      const lad = process.env.LOCALAPPDATA || '';
      if (!lad) {
        console.error('  LOCALAPPDATA is not set - this install is Windows-only.');
        process.exit(2);
      }
      const r = installIntoWindowsTerminal(lad);
      console.log((r.ok ? '  ok  ' : '  FAILED  ') + r.message);
      if (r.path) console.log('  ' + r.path);
      if (r.ok) console.log('  Open a NEW tab for it to take effect.');
      process.exit(r.ok ? 0 : 1);
    }
    if (!want || !(INIT_SHELLS as readonly string[]).includes(want)) {
      console.error(`  Usage: awsh init <${INIT_SHELLS.join('|')}|terminal>`);
      console.error('');
      console.error('  PowerShell   awsh init pwsh | Out-String | Invoke-Expression');
      console.error('  bash/zsh     eval "$(awsh init bash)"');
      console.error('');
      console.error('  Add that line to your profile to make it permanent.');
      process.exit(2);
    }
    process.stdout.write(omniboxInitScript(want as any));
    return;
  }

  // ── `awsh setup` — make this machine work, and PROVE each step ──────────
  //
  // Written after a real install failed four different ways in sequence, every
  // one of them SILENTLY: a shim on a PATH only the installing process had, a
  // profile write that reported success and changed nothing, an endpoint
  // serving HTML, and packs behind a stale env pointer. None of them raised;
  // each just made a feature quietly absent.
  //
  // So this is not "run the install steps". It is "run them and then LOOK",
  // and print a verdict per step including the ones it could not fix.
  if (args[0] === 'setup') {
    const { runSetup } = await import('./setup.js');
    const { omniboxInitScript } = await import('./omnibox.js');
    const { discoverPacks } = await import('./packs.js');
    const { CLOUD_URL } = await import('./config.js');

    const cfg0 = loadConfig();
    const packCount = discoverPacks(process.env.AITHEROS_ROOT || process.cwd()).length;
    const steps = await runSetup({
      initScript: omniboxInitScript('pwsh'),
      // Local gateway first: on-box it needs no tunnel and no public edge.
      endpointCandidates: [
        ...(cfg0.genesisUrl ? [cfg0.genesisUrl] : []),
        'http://127.0.0.1:8182',
        CLOUD_URL,
      ],
      packCount,
    });

    console.log();
    let bad = 0;
    for (const s of steps) {
      const mark = s.state === 'ok' ? chalk.green('ok   ')
                 : s.state === 'fixed' ? chalk.cyan('fixed')
                 : s.state === 'skipped' ? chalk.dim('skip ')
                 : chalk.red('FAIL ');
      if (s.state === 'failed') bad++;
      console.log(`  ${mark} ${chalk.bold(s.name)}`);
      console.log(chalk.dim(`        ${s.detail}`));
    }

    // If the endpoint step found a working URL that is not what is configured,
    // persist it -- an install that leaves a known-bad endpoint in place has
    // not finished.
    const ep = steps.find(s => s.name === 'inference endpoint') as { url?: string } | undefined;
    if (ep?.url && ep.url !== cfg0.genesisUrl) {
      const { writeFileSync: wf, readFileSync: rf, existsSync: ex } = await import('node:fs');
      const { join: j } = await import('node:path');
      const { homedir: hd } = await import('node:os');
      const yaml = j(hd(), '.aither', 'shell.yaml');
      try {
        const cur = ex(yaml) ? rf(yaml, 'utf-8') : '';
        const next = cur.includes('api_url:')
          ? cur.replace(/api_url:.*/g, 'api_url: ' + ep.url)
          : cur + (cur.endsWith(String.fromCharCode(10)) ? '' : String.fromCharCode(10))
              + 'api_url: ' + ep.url + String.fromCharCode(10);
        wf(yaml, next, 'utf-8');
        console.log(chalk.dim(`        repointed api_url -> ${ep.url}`));
      } catch { /* reported by the step above; not worth a second failure */ }
    }

    console.log();
    console.log(bad === 0
      ? chalk.dim('  Open a NEW terminal, then type a question where a command goes.')
      : chalk.yellow(`  ${bad} step(s) could not be completed — see above.`));
    process.exit(bad === 0 ? 0 : 1);
  }

  // ── `awsh packs` — what brains are installed ─────────────────────────────
  if (args[0] === 'packs' || args[0] === 'brains') {
    const { discoverPacks, isUsable } = await import('./packs.js');
    const root = process.env.AITHEROS_ROOT || process.cwd();
    const packs = discoverPacks(root);
    if (!packs.length) {
      console.log(`  No packs found under ${root}.`);
      console.log('  Set AITHEROS_ROOT to the repo root if you are outside it.');
      return;
    }
    console.log();
    for (const p of packs) {
      const ok = isUsable(p);
      const mark = ok ? chalk.green('◈') : chalk.yellow('·');
      const note = ok ? chalk.dim(p.title || '') : chalk.yellow('(no system prompt — not usable)');
      console.log(`  ${mark} ${chalk.bold(p.name.padEnd(22))} ${note}`);
    }
    console.log();
    console.log(chalk.dim(`  Launch one:  awsh <name>       e.g. awsh ${packs.find(isUsable)?.name || 'gobbonet'}`));
    console.log();
    return;
  }

  // ── `awsh <pack>` — launch the shell wearing a different brain ────────────
  //
  // This is the "alt shell" move: `awsh gobbonet` is to awsh what `fish` is to
  // bash — same terminal, different opinions. The discriminator lives in
  // packs.ts and is deliberately strict (ONE bare word, exact match, pack must
  // actually be usable) so `awsh what is gobbonet` stays a question. Mistaking a
  // question for a launch would discard what the user typed; mistaking a pack
  // name for a question merely answers it.
  // A pack name typed WHERE A COMMAND GOES should enter the pack. That is the
  // whole "alt shell" premise, and without this the omnibox hands the name to
  // the agent, which answers with a confident guess about a command that
  // genuinely exists -- measured 2026-08-21: typing `gobbonet` returned "It
  // appears to be a typo. The intended command might have been 'go'."
  //
  // The rewrite happens ONLY when the name resolves to a launchable pack, so a
  // word that is not a pack still reaches the omnibox prompt untouched. Doing it
  // the other way round -- rewrite first, ask questions later -- would strip the
  // omnibox context from every ordinary miss.
  if (args[0] === 'ask' && args.includes('--omnibox')) {
    const sep = args.indexOf('--');
    const line = (sep >= 0
      ? args.slice(sep + 1)
      : args.slice(1).filter(a => a !== '--omnibox')
    ).join(' ').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(line)) {
      const { findPack: fp, isUsable: usable } = await import('./packs.js');
      const p = fp(process.env.AITHEROS_ROOT || process.cwd(), line);
      if (p && usable(p)) {
        args.length = 0;
        args.push(p.name);          // hand it to the launcher below, unchanged
      }
    }
  }

  {
    const { looksLikePackLaunch, findPack, isUsable } = await import('./packs.js');
    const candidate = looksLikePackLaunch(args);
    if (candidate) {
      const root = process.env.AITHEROS_ROOT || process.cwd();
      const pack = findPack(root, candidate);
      // Not a pack → fall through to ordinary one-shot chat, unchanged.
      if (pack) {
        if (!isUsable(pack)) {
          console.error(`  Pack '${pack.name}' has no system_prompt, so it cannot change`);
          console.error(`  how the shell behaves. Manifest: ${pack.manifest}`);
          console.error('  Refusing to launch rather than pretend it loaded.');
          process.exit(2);
        }
        const cfg = loadConfig();
        cfg.packName = pack.name;
        cfg.packManifest = pack.manifest;
        cfg.packDeclaresApp = Boolean(pack.appScript);
        cfg.packSecretFile = pack.appSecretFile;
        cfg.packCommands = pack.commands || [];
        cfg.packPrompt = pack.systemPrompt;
        cfg.packTitle = pack.title;
        cfg.packIdentity = pack.identity;
        // NOTE: identity is shown in the banner but not forced onto the config.
        // ShellConfig carries no `agent` field -- the agent is a per-call option
        // (`persona` on the genesis path), and the SYSTEM PROMPT injected in
        // client.ts is what actually changes behaviour on the gateway path that
        // one-shots and the omnibox use. Adding config plumbing that only the
        // genesis path reads would look like it worked and mostly not.
        setActiveConfig(cfg);
        console.log();
        console.log(`  ${chalk.magenta('◈')} ${chalk.bold(pack.title || pack.name)}` +
                    chalk.dim(`  ·  pack ${pack.name}`) +
                    (pack.identity ? chalk.dim(`  ·  as ${pack.identity}`) : ''));
        console.log(chalk.dim(`     ${pack.manifest}`));
        // Only advertised when the pack actually HAS an app. A hint for a
        // capability the pack does not declare is worse than no hint: it sends
        // the user to a command that will tell them nothing exists.
        //
        // pack.appScript, NOT a cast to a snake_case shape. The manifest key is
        // app_script but packs.ts normalises it to appScript, and casting to an
        // invented type is what stopped the compiler from saying so -- the check
        // was silently always false and the hint never printed.
        if (pack.appScript) {
          console.log(chalk.dim('     ') + chalk.cyan('/gui') + chalk.dim('  open the full app in a browser'));
        }
        console.log();
        await startRepl(new GenesisClient(cfg.genesisUrl), cfg);
        return;
      }
    }
  }

  // ── `awsh doctor` — is the omnibox actually worth having on this machine ──
  //
  // This exists because the claim came BEFORE the code: omnibox.ts documented a
  // budget check that nothing in production ever ran (judgeOmnibox was reachable
  // only from the test suite, so 23 green tests covered a dead feature). Here is
  // where the measurement actually happens.
  //
  // It measures rather than guesses, because the number is the whole point: the
  // same missing command resolved in 81 ms on a healthy PSModulePath and took
  // over 60 s with a source tree on it.
  if (args[0] === 'doctor') {
    const { judgeOmnibox, classifyModulePath, MISS_BUDGET_MS } = await import('./omnibox.js');
    if (process.platform !== 'win32') {
      console.log('  doctor: the PSModulePath check is Windows/PowerShell only.');
      console.log('  On bash/zsh a missing command is not scanned against a module path,');
      console.log('  so the stall this measures cannot occur. Nothing to check.');
      return;
    }
    const { execFileSync } = await import('child_process');
    // One pwsh, doing both halves, so we pay process startup once.
    const ps = `
$sw=[Diagnostics.Stopwatch]::StartNew()
try { awsh-doctor-probe-missing-command } catch {}
$sw.Stop()
$rows = @()
foreach ($e in ($env:PSModulePath -split [IO.Path]::PathSeparator | Where-Object { $_ })) {
  if (-not [IO.Directory]::Exists($e)) { continue }
  $d = @([IO.Directory]::GetDirectories($e)).Count
  $m = 0
  # $sub, NOT $d -- reusing $d as the loop variable clobbers the directory COUNT
  # with the last directory PATH, so the row emitted below starts with a path
  # instead of a number and the parser silently matches nothing. That printed
  # "Offending entries: (none identified)" while the offender was right there: a
  # wrong answer wearing the shape of a clean one.
  foreach ($sub in [IO.Directory]::GetDirectories($e)) {
    $leaf = [IO.Path]::GetFileName($sub)
    if ([IO.File]::Exists([IO.Path]::Combine($sub, "$leaf.psd1"))) { $m++ }
  }
  $rows += "$d|$m|$e"
}
[Console]::Out.WriteLine("MISS=" + $sw.ElapsedMilliseconds)
$rows | ForEach-Object { [Console]::Out.WriteLine("PATH=" + $_) }`;
    let out = '';
    try {
      out = execFileSync('pwsh', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 180_000 });
    } catch (err: any) {
      // A probe that could not run is NOT a pass — exit 2, never 0.
      console.error(`  doctor: could not run the probe (${err?.message || err}).`);
      console.error('  No verdict. That is not the same as "healthy".');
      process.exit(2);
    }
    const missMs = Number(/MISS=(\d+)/.exec(out)?.[1] ?? -1);
    const offenders: string[] = [];
    for (const m of out.matchAll(/PATH=(\d+)\|(\d+)\|(.+)/g)) {
      const [dirs, manifests, entry] = [Number(m[1]), Number(m[2]), m[3].trim()];
      if (classifyModulePath(entry, dirs, manifests)) {
        offenders.push(`${entry} (${dirs} dirs, ${manifests} manifests)`);
      }
    }
    const v = judgeOmnibox(missMs, offenders);
    console.log(`  command-miss resolution : ${missMs} ms   (budget ${MISS_BUDGET_MS} ms)`);
    console.log(`  verdict                 : ${v.ok ? 'OK — install it' : 'NOT worth installing yet'}`);
    console.log(`  ${v.reason}`);
    if (v.remedy) console.log(`  remedy: ${v.remedy}`);
    process.exit(v.ok ? 0 : 1);
  }

  // ── `awsh ask --omnibox -- <line>` — a line that was not a command ────
  //
  // Invoked by the shell hook, never typed by a human. It rewrites argv into
  // the ordinary one-shot chat path rather than opening a second code path to
  // the agent: a rival dispatch here would drift from the real one, and the
  // drift would only show up for the people using the feature that has no
  // other way to be tested.
  if (args[0] === 'ask' && args.includes('--omnibox')) {
    const sep = args.indexOf('--');
    const line = (sep >= 0
      ? args.slice(sep + 1)
      : args.slice(1).filter(a => a !== '--omnibox')
    ).join(' ').trim();

    // Nothing to ask. Exit 127 — the shell's own not-found code — so a script
    // that somehow reached here still sees a conventional failure.
    if (!line) process.exit(127);

    args.length = 0;

    // ONE conversation per terminal. Each omnibox line is a separate process,
    // and until 2026-08-23 each was a separate session too: the owner typed
    // "what time is it", got the time, typed "how do you know that?" and the
    // agent — with no memory of the previous line — answered a question about
    // epistemology. The hook passes the shell's own $PID, so every line typed
    // in that window resumes the same transcript; the session store already
    // persists it and --resume already replays it. Deterministic answers
    // (below) are recorded into it too, or the follow-up has nothing to follow.
    const omniboxSid = `omnibox-${(process.env.AWSH_OMNIBOX_SESSION || String(process.ppid)).trim()}`;
    const { loadSession: loadSess, recordTurn: recordOmniboxTurn } = await import('./session-store.js');
    if (loadSess(omniboxSid)) args.push('--resume', omniboxSid);
    else process.env.AWSH_OMNIBOX_NEW_SESSION = omniboxSid;
    // The transcript must hold what the HUMAN typed, not the wrapper prompt
    // below -- a resumed summary full of "This was typed at a shell prompt..."
    // is noise the model then imitates.
    process.env.AWSH_OMNIBOX_LINE = line;

    // A pure state question (time, date, cwd, whoami, hostname) is answered by
    // the SHELL, now, from its own registers -- not by the model. Measured
    // 2026-08-23: with the clock in context the model stated the time on one
    // run and on the next printed only `Get-Date -DisplayHint DateTime`, and
    // on the owner's run echoed the line back. A fact the shell holds must not
    // depend on a small model's mood -- and measured, it bolted junk `-Format`
    // strings onto Get-Date on 5 of 6 runs however it was asked. So both
    // halves are deterministic: the value, then the idiomatic command for
    // THIS shell, and the model is not consulted at all.
    const { answerFromSituation, collectSituation, sniffShellName } = await import('./situation.js');
    const fact = answerFromSituation(line, collectSituation(sniffShellName() ?? ''));
    if (fact) {
      console.log(fact.value);
      console.log(chalk.dim(`  ${fact.command}`));
      // Into the terminal's transcript, so "how do you know that?" next has
      // something to refer to. Phrased as the shell speaking, which it is.
      try {
        recordOmniboxTurn(omniboxSid, 'aither', line,
          `${fact.value} -- I read this directly from this machine's own system ` +
          `state (its clock / working directory / user / hostname), not from memory ` +
          `or the internet. The shell command that prints the same value is: ${fact.command}`);
      } catch { /* a transcript write must never fail the answer */ }
      process.exit(0);
    }

    // The framing goes in the SYSTEM slot, and the bare line stays the MESSAGE.
    //
    // Until 2026-08-23 this text was concatenated in FRONT of the user's line,
    // so the model received ~130 words of instructions with the question buried
    // at the end -- and answered the instructions. Measured that day against the
    // live daemon, same endpoint, same model, same registered tools, 3 runs each:
    //
    //     "what is in the news today"   no framing        : tool called 3/3
    //                                    framing as system : tool called 3/3
    //                                    framing prepended : tool called 0/3
    //                                    prepended, reworded
    //                                      to invite tools : tool called 1/3
    //
    // That last row is why this is a SLOT change and not a better sentence:
    // rewording while leaving the text in the user slot moved 0/3 to 1/3, which
    // reads like progress and is a coin flip.
    //
    // The user-visible symptom was the omnibox replying "I cannot directly fetch
    // news" while web_search was registered, bound and answering when asked
    // directly. A capability the model never considers is indistinguishable from
    // one that does not exist -- the same class as the intent filter that hid
    // these tools until the day before. Pinned by
    // test/omnibox-framing-slot.test.ts, in BOTH directions: the framing must
    // not be in the message, and it must not be lost.
    process.env.AWSH_OMNIBOX_FRAMING =
      'The user typed this at a shell prompt where a command was expected, but no ' +
      'such command exists. Work out what was meant and do it: answer the ' +
      'question if it is one; if it names a site or URL, say so and give the ' +
      'link; if it is a near-miss of a real command, say which and show the ' +
      'corrected line. Answer in a few lines of plain terminal text, no ' +
      'markdown headers, no preamble — and NEVER open by explaining that the ' +
      'line is not a command or is a question; the user knows, just answer. ' +
      'If a conversation so far is provided, the line may be a follow-up to ' +
      'it: answer in that context. The current time, date, cwd, user and ' +
      'host are in the [USER\'S SHELL] system block — if the line touches ' +
      'any of those, read the real value from that block rather than calling a ' +
      'tool, and never invent a sample date. For ANYTHING ELSE your tools are ' +
      'available and you are expected to use them: if answering needs anything ' +
      'current, live, or specific to this machine, call the tool first and ' +
      'answer from its result rather than saying you are unable to look it up. ' +
      // Only the SYNTHESIS instruction stays here. Asking for URLs too was
      // tried and REMOVED: the longer framing dropped tool use to 2/3 (one run
      // in three went back to "I do not have live news access"), and the links
      // are no longer the model's job -- the shell prints the sources from the
      // tool output itself, clickable, whatever the model chose to write.
      'Lead with what the results actually SAY - the specific stories, findings ' +
      'or values - never with a list of the sources you searched.';
    args.push(line);
  }

  const config = loadConfig();
  setActiveConfig(config);
  // First omnibox line in this terminal: no transcript to resume yet, but the
  // turn must be RECORDED under the terminal's id so the next line can resume it.
  if (process.env.AWSH_OMNIBOX_NEW_SESSION) config.sessionId = process.env.AWSH_OMNIBOX_NEW_SESSION;
  const client = new GenesisClient(config.genesisUrl);

  // Wire auth token from config to client
  if (config.authToken) {
    client.setAuthToken(config.authToken, config.authUser?.tenant_id ?? null, config.authUser?.id ?? null);
  }

  // Handle --login and --key flags for non-interactive auth
  const loginIdx = args.indexOf('--login');
  const keyIdx = args.indexOf('--key');
  if (keyIdx >= 0 && args[keyIdx + 1]) {
    const { validateToken: valToken, buildProfile, setProfile } = await import('./auth.js');
    const token = args[keyIdx + 1];
    const user = await valToken(config.identityUrl, token);
    if (user) {
      const profile = buildProfile(config.identityUrl, config.genesisUrl, {
        access_token: token, token_type: 'api_key', user,
      });
      setProfile('local', profile);
      config.authToken = token;
      config.authUser = profile.user;
      client.setAuthToken(token, profile.user.tenant_id || null, profile.user.id || null);
    } else {
      console.error(chalk.red('Invalid API key'));
      process.exit(1);
    }
  }

  // Parse creative flags (--will, --safety, --private, --effort) early
  // so they apply to both runOneShot and positional one-shot chat.
  let printPrompt = '';  // prompt captured from `-p <prompt>`
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--will' || args[i] === '--agent' || args[i] === '-a') && args[i + 1]) {
      config.defaultAgent = args[i + 1];
    } else if ((args[i] === '--effort' || args[i] === '-e') && args[i + 1]) {
      config.effort = Number(args[i + 1]);
    } else if ((args[i] === '--safety' || args[i] === '-s') && args[i + 1]) {
      config.safetyLevel = args[i + 1];
    } else if (args[i] === '--private') {
      config.privateMode = true;
    } else if ((args[i] === '--image' || args[i] === '-i') && args[i + 1]) {
      const imgPath = args[++i];
      try {
        const buf = readFileSync(imgPath);
        const ext = extname(imgPath).toLowerCase().replace('.', '');
        const mimeMap: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
        const mime = mimeMap[ext] || 'png';
        const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
        config.imageAttachments = config.imageAttachments || [];
        config.imageAttachments.push(dataUrl);
      } catch (err: any) {
        console.error(chalk.red(`Cannot read image: ${imgPath} — ${err.message}`));
        process.exit(1);
      }
    } else if (args[i] === '--print' || args[i] === '-p') {
      config.printMode = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) printPrompt = args[++i];
    } else if (args[i] === '--output-format' && args[i + 1]) {
      const f = args[++i];
      config.outputFormat = (f === 'json' || f === 'stream-json') ? f : 'text';
    } else if (args[i] === '--json') {
      config.outputFormat = 'json'; config.printMode = true;
    } else if (args[i] === '--continue' || args[i] === '-C') {
      config.resumeSessionId = '__continue__';  // sentinel → most-recent session
    } else if ((args[i] === '--resume' || args[i] === '--session') && args[i + 1]) {
      config.resumeSessionId = args[++i];
    } else if (args[i] === '--gateway') {
      // Portable thin-client mode: point inference + tools at the public gateway.
      // Accepts an optional URL (default gateway.aitherium.com — the host that
      // actually serves /v1 inference; mcp.aitherium.com is a coming-soon
      // placeholder). Forces raw inference unless --inference-mode overrides it.
      const url = (args[i + 1] && !args[i + 1].startsWith('-'))
        ? args[++i].replace(/\/+$/, '')
        : 'https://gateway.aitherium.com';
      config.genesisUrl = url;
      config.mcpUrl = config.mcpUrl || `${url}/mcp`;
      config.llmUrl = config.llmUrl || `${url}/v1`;
      if (config.inferenceMode === 'auto') config.inferenceMode = 'raw';
      config.endpointPinned = true;  // explicit choice → no auto-failover override
      client.setBaseUrl(url);  // repoint the already-constructed client
    } else if (args[i] === '--inference-mode' && args[i + 1]) {
      const m = args[++i].toLowerCase();
      if (m === 'auto' || m === 'genesis' || m === 'raw') config.inferenceMode = m;
    } else if (args[i] === '--deepseek') {
      // Direct DeepSeek: `--deepseek [flash|reasoner|<model>]`. Talks straight to
      // api.deepseek.com with DEEPSEEK_API_KEY — no fleet required. An explicit
      // provider choice, so it pins the endpoint (no auto-failover override).
      const variant = (args[i + 1] && !args[i + 1].startsWith('-')) ? args[++i] : undefined;
      config.provider = deepseekProvider(variant);
      config.inferenceMode = 'raw';
      config.endpointPinned = true;
    } else if (args[i] === '--kimi' || args[i] === '--moonshot') {
      // Direct Moonshot Kimi: `--kimi [k3|max|<model>]`. Talks straight to
      // api.moonshot.ai with MOONSHOT_API_KEY — no fleet required. An explicit
      // provider choice, so it pins the endpoint (no auto-failover override).
      const variant = (args[i + 1] && !args[i + 1].startsWith('-')) ? args[++i] : undefined;
      config.provider = kimiProvider(variant);
      config.inferenceMode = 'raw';
      config.endpointPinned = true;
    }
  }

  // If invoked as "aither-install" (binary name contains "install"), run install flow directly
  const binaryName = process.argv[1] ? basename(process.argv[1]).toLowerCase() : '';
  if (binaryName.includes('install') && !args.includes('-c') && !args.includes('--command')) {
    const { getCommand } = await import('./commands.js');
    const installCmd = getCommand('install');
    if (installCmd) {
      await installCmd.handler(client, args.join(' '), config);
      process.exit(0);
    }
  }

  // ── Explicit auth subcommands ──────────────────────────────────────────
  // `aither login [--browser]`, `aither logout`, `aither whoami`. Without these,
  // "login" fell through to positional one-shot chat → POSTed to the gateway's
  // /chat/stream (which the OpenAI-compat gateway doesn't serve) → 404, surfaced
  // as a confusing "Error: not_found". Device login always uses the IDENTITY URL.
  if (args[0] === 'login') {
    await ensureDeviceLogin(client, config);
    process.exit(0);
  }
  if (args[0] === 'logout') {
    const { clearProfile } = await import('./auth.js');
    clearProfile('local');
    console.log(chalk.green('  ✓ Signed out (cleared local profile).'));
    process.exit(0);
  }
  if (args[0] === 'whoami') {
    const u = config.authUser;
    console.log(u
      ? `  ${chalk.bold(u.display_name || u.username)} <${u.email}>`
      : chalk.yellow('  Not signed in. Run `aither login`.'));
    process.exit(0);
  }

  // ── Remote terminal: `aither connect` / `aither ssh` ────────────────────
  // Open a raw interactive shell into a prod/dev environment through the tunnel
  // (wss://<tunnel>/tunnel/ssh) from ANY PC. Must work as a top-level subcommand
  // BEFORE the REPL. Device-login first if needed.
  if (args[0] === 'connect' || args[0] === 'ssh') {
    const rest = args.slice(1);
    let container: string | undefined;
    let host: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '--container' || rest[i] === '-c') && rest[i + 1]) { container = rest[++i]; }
      else if ((rest[i] === '--tunnel' || rest[i] === '--host') && rest[i + 1]) { host = rest[++i]; }
      else if (!rest[i].startsWith('-') && !container) { container = rest[i]; }
    }
    const { getActiveToken } = await import('./auth.js');
    if (!getActiveToken()) { await ensureDeviceLogin(client, config); }
    const { connectTerminal } = await import('./terminal.js');
    const code = await connectTerminal({ container, host });
    process.exit(code);
  }

  // ── Python AitherShell passthrough (adk-shell) ─────────────────────────
  // The command-center surfaces live in the Python shell (awdk):
  // sessions manager/browser, hq dashboard, unified inbox, agents console,
  // palette, brief, watchtower, docker recovery. Without this passthrough,
  // `aither sessions` was intent-classified as a CHAT PROMPT. Spawn adk-shell
  // with inherited stdio so its TUIs own the terminal.
  const PY_SHELL_CMDS = new Set([
    'sessions', 'hq', 'inbox', 'palette', 'brief', 'watch', 'agents', 'docker',
  ]);
  if (args[0] && PY_SHELL_CMDS.has(args[0].toLowerCase())) {
    const { spawnSync } = await import('node:child_process');
    const runs = process.platform === 'win32'
      ? [['adk-shell.exe', args], ['adk-shell', args], ['python', ['-m', 'adk.shell', ...args]]]
      : [['adk-shell', args], ['python3', ['-m', 'adk.shell', ...args]]];
    let ran = false;
    for (const [cmd, cmdArgs] of runs as [string, string[]][]) {
      const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
      if (!res.error) {
        process.exitCode = res.status ?? 0;
        ran = true;
        break;
      }
    }
    if (!ran) {
      console.error(chalk.yellow(
        `  '${args[0]}' needs the Python AitherShell. Install it with:\n` +
        '    pip install "awdk[shell,platform]"'));
      process.exitCode = 1;
    }
    return;
  }

  // ── Explicit one-shot subcommands that must NOT fall through to chat ──
  // e.g. `aither node ls`, `aither node enroll --tenant acme`. Without this,
  // "node ls" became a positional chat prompt → intent-classified as a query.
  // `aither harness …` is intercepted BEFORE backend resolution: the harness
  // daemon is the local process supervisor and is reachable when Genesis is
  // not, so making it wait on a chat backend would break it exactly when it is
  // most useful.
  if (args[0] && args[0].toLowerCase() === 'harness') {
    const { runHarnessCommand } = await import('./harness-client.js');
    process.exitCode = await runHarnessCommand(args.slice(1));
    return;
  }

  // `aither room` — the AitherAeon six-pillar view. Intercepted here for the same
  // reason as `harness`: the room lives on the harness daemon, which is a host
  // process that answers when Genesis and the whole container fleet do not. Making
  // it wait on a chat backend would take it down exactly when it is most useful —
  // watching what the agents are doing while the fleet is broken is the point.
  if (args[0] && args[0].toLowerCase() === 'room') {
    const { runRoomCommand } = await import('./room-command.js');
    process.exitCode = await runRoomCommand(args.slice(1));
    return;
  }

  // `aither bonsai` — run Bonsai locally on llama.cpp. Intercepted here for the same reason
  // as `harness` and `room`: llama.cpp is a HOST process and answers when Genesis and the
  // container fleet do not. Making local inference wait on a chat backend would take it away
  // exactly when it is most useful — a dead fleet is when you most want a model of your own.
  if (args[0] && args[0].toLowerCase() === 'bonsai') {
    const { runBonsaiCommand } = await import('./bonsai-local.js');
    const { loadConfig } = await import('./config.js');
    process.exitCode = await runBonsaiCommand(args.slice(1), loadConfig().genesisUrl);
    return;
  }

  // `aither well` — draw the ambient context: branch, changes, file locks, agents.
  // Like `harness` and `room`, this is intercepted before backend resolution because
  // the well daemon is a host process that survives when the fleet does not.
  if (args[0] && args[0].toLowerCase() === 'well') {
    const { runWellCommand } = await import('./well-command.js');
    process.exitCode = await runWellCommand(args.slice(1));
    return;
  }

  // `aither decisions …` and `aither decide …` — the decision-card surface for the CLI.
  // Like `harness` and `room`, this is intercepted before backend resolution because
  // the daemon is a host process that survives when Genesis does not, so this must
  // not depend on backend resolution.
  if (args[0] && (args[0].toLowerCase() === 'decisions' || args[0].toLowerCase() === 'decide')) {
    const { runDecisionsCommand } = await import('./decisions-client.js');
    process.exitCode = await runDecisionsCommand(args.slice(1));
    return;
  }

  const ONESHOT_CMDS = new Set(['node', 'nodes', 'install']);
  if (args[0] && ONESHOT_CMDS.has(args[0].toLowerCase())) {
    const { getCommand } = await import('./commands.js');
    const cmd = getCommand(args[0].toLowerCase());
    if (cmd) {
      await cmd.handler(client, args.slice(1).join(' '), config);
      // Return (don't process.exit) so libuv drains the fetch keep-alive socket
      // cleanly — a bare process.exit() here races teardown → UV_HANDLE_CLOSING
      // assert on Windows. undici idle sockets are unref'd, so the loop ends.
      process.exitCode = 0;
      return;
    }
  }

  // ── Backend resolution (the "never dead" guarantee) ────────────────────
  // Pick the best reachable backend BEFORE anything talks to it: local Genesis
  // if it's up, else transparently fail over to the public cloud gateway. Runs
  // for every interactive/headless chat path (skipped above for pure subcommands
  // like node/install/login that don't need a chat backend). Repoint the client
  // and, on a cloud failover, announce it non-blockingly.
  if (config.provider) {
    // Direct provider (DeepSeek etc): no backend probing/failover — it talks
    // straight to its own endpoint. Announce it (and warn if the key is missing).
    if (!config.printMode) {
      const p = config.provider;
      console.log();
      console.log(chalk.cyan(`  ◈ Using ${p.name} directly`) + chalk.dim(` — model ${p.model}`));
      if (!p.apiKey) {
        console.log(chalk.yellow('    No API key set — ') + chalk.dim('export DEEPSEEK_API_KEY=… (or AITHER_DEEPSEEK_API_KEY).'));
      }
    }
  }
  const resolved = config.provider
    ? { switched: false, chosen: 'pinned' as const, url: config.genesisUrl, reachable: true }
    : await resolveBackend(config);
  if (resolved.switched) {
    client.setBaseUrl(config.genesisUrl);
    setActiveConfig(config);  // refresh the process-wide bridge with cloud URLs
    if (!config.printMode) {
      console.log();
      console.log(chalk.yellow('  ⚠ Local AitherOS backend is offline — using the cloud gateway')
        + chalk.dim(` (${new URL(config.genesisUrl).host}).`));
      if (!config.authToken) {
        console.log(chalk.dim('    Run ') + chalk.cyan('/login') + chalk.dim(' to sign in for full access.'));
      }
    }
  }

  // `aither caps …` — the effective-capability surface.
  //
  // Dispatched HERE, after backend resolution, and NOT alongside `decisions` /
  // `harness` / `room` above. Those are intercepted early on purpose: their
  // daemon is a host process that outlives the fleet. The capability resolver is
  // the opposite — it needs the CapabilityEngine and the RBAC store, so it must
  // run against a resolved backend and must report "unreachable" rather than
  // inventing a local answer.
  if (args[0] && args[0].toLowerCase() === 'caps') {
    const { runCapsCommand } = await import('./capabilities-client.js');
    const headers: Record<string, string> = {};
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    process.exitCode = await runCapsCommand(args.slice(1), config.genesisUrl, headers);
    return;
  }

  // Try non-interactive (flag-based) execution first
  const handled = await runOneShot(client, config);
  if (handled) process.exit(0);

  // Enable remote session sync, then resolve any --continue/--resume/--session.
  configureRemoteSync(config.genesisUrl, config.authToken);
  let resumeSummary = '';
  if (config.resumeSessionId === '__continue__') {
    const r = await resolveResume(client, config, 'continue');
    resumeSummary = r?.summary || '';
    if (!r) console.error(chalk.yellow('No previous session to continue.'));
  } else if (config.resumeSessionId) {
    const r = await resolveResume(client, config, 'id', config.resumeSessionId);
    resumeSummary = r?.summary || '';
  }

  // Collect positional args — the one-shot message.
  //
  // This used to `break` on the FIRST flag, which made every documented
  // flag+message form silently unreachable: `aither -e 1 "msg"` collected zero
  // positionals and dropped into the interactive REPL instead of answering and
  // exiting. Nothing errored — the shell just did something else, which in a
  // script is a hang. The flags are already parsed above; here we only need to
  // skip them (and their values) and keep everything else.
  const positional = collectPositional(args);

  const wantsHeadless = positional.length > 0 || config.printMode;
  if (wantsHeadless) {
    let prompt = positional.join(' ') || printPrompt;
    if (config.printMode) {
      const piped = await readStdin();
      prompt = [prompt, piped].filter(Boolean).join('\n\n');
    }
    if (!prompt.trim()) {
      console.error(chalk.red('No prompt provided (positional argument or piped stdin).'));
      process.exit(1);
    }
    const ok = await oneShotChat(client, config, prompt, resumeSummary);
    process.exit(ok ? 0 : 1);
  } else {
    // Remote endpoints force a real sign-in before the shell opens.
    if (config.requireAuth && !config.authToken) {
      await ensureDeviceLogin(client, config);
    }
    await showBanner(client, config);
    await startRepl(client, config);
  }
}

/* ── Banner with live status ────────────────────────────────── */

// probeHealth / buildProbes / pickServingModel moved to ./status-banner.ts
// (shared with the in-TUI live status header).

/** Force a device-flow login when the endpoint requires auth and no valid
 *  token exists. Reuses the existing device-code helpers; prints the
 *  server-provided verification URL (portal.aitherium.com/link) + user code,
 *  then polls until the user approves in the browser. */
async function ensureDeviceLogin(client: GenesisClient, config: ShellConfig): Promise<void> {
  const { requestDeviceCode, pollDeviceToken, buildProfile, setProfile } = await import('./auth.js');
  console.log();
  console.log(chalk.bold('  🔐 This endpoint requires sign-in (no local root).'));
  try {
    const dc = await requestDeviceCode(config.identityUrl, 'AitherShell');
    console.log();
    console.log('  Open this URL in your browser and approve the device:');
    console.log('  ' + chalk.cyan(dc.verification_uri_complete || dc.verification_uri));
    if (dc.user_code) {
      console.log();
      console.log('  Code: ' + chalk.bold.yellow(dc.user_code));
    }
    console.log();
    process.stdout.write(chalk.dim('  Waiting for authorization'));
    const deadline = Date.now() + (dc.expires_in || 900) * 1000;
    const interval = Math.max(2, dc.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      try {
        const result = await pollDeviceToken(config.identityUrl, dc.device_code);
        if ((result.status === 'complete' || result.status === 'authorized') && result.access_token) {
          const profile = buildProfile(config.identityUrl, config.genesisUrl, result);
          setProfile('local', profile);
          config.authToken = profile.access_token;
          config.authUser = profile.user;
          client.setAuthToken(profile.access_token, profile.user.tenant_id || null, profile.user.id || null);
          console.log();
          console.log(chalk.green(`  ✓ Signed in as ${chalk.bold(profile.user.display_name || profile.user.username)} (${profile.user.email})`));
          // Register this endpoint/agent with the mesh under the signed-in user.
          await registerRemoteEndpoint(config);
          console.log();
          return;
        }
      } catch (err: any) {
        if (String(err?.message || '').includes('expired')) {
          console.log();
          console.log(chalk.red('  Device code expired — re-run `aither` to retry.'));
          return;
        }
        // authorization_pending — keep polling
      }
      process.stdout.write(chalk.dim('.'));
    }
    console.log();
    console.log(chalk.yellow('  Sign-in timed out. Run `/login --browser` from the shell to retry.'));
  } catch (err: any) {
    console.log();
    console.log(chalk.red(`  Could not start sign-in: ${err.message}`));
    console.log(chalk.dim('  Run `/login` from the shell to try another method.'));
  }
}

/** Best-effort: register this workspace as a mesh node/agent under the
 *  signed-in user via the public gateway (POST /v1/mesh/join). Ties the
 *  endpoint/agent registration to the authenticated identity. Never throws. */
async function registerRemoteEndpoint(config: ShellConfig): Promise<void> {
  if (!config.authToken) return;
  const base = config.genesisUrl.replace(/\/+$/, '');
  const who = config.authUser?.username || config.authUser?.email || 'agent';
  const nodeName = `devws-${who}-${(process.env.HOSTNAME || '').slice(0, 12)}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
  try {
    const r = await fetch(`${base}/v1/mesh/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.authToken}` },
      body: JSON.stringify({
        node_name: nodeName,
        capabilities: ['dev-workspace', 'aither-cli'],
        endpoint: process.env.AITHER_MESH_IP || '',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) console.log(chalk.dim('  ✓ Endpoint registered with AitherMesh.'));
  } catch { /* best-effort — registration is also done server-side at spawn */ }
}

// _BACKEND_WHERE / pickServingModel moved to ./status-banner.ts.

/** Warm the orchestrator model on connect so the first real turn isn't cold.
 *  Visible (the user asked to SEE it) and best-effort — never blocks for long
 *  and never throws. Also fires a non-awaited Genesis context nudge so the
 *  code/knowledge-graph gather is warm by the first message too. */
async function warmOnConnect(client: GenesisClient, config: ShellConfig, model?: string) {
  if (process.env.AITHER_NO_WARMUP) return;
  const target = model || config.model || DEFAULT_AGENT;
  // (silent: the warm-up still runs, it just no longer narrates itself)
  // Fire-and-forget context warm (don't block the prompt on the heavy pipeline).
  void fetch(`${config.genesisUrl.replace(/\/+$/, '')}/status`, {
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
  // Silent on success: a warm-up the user did not ask for and cannot act on is
  // not news, and it landed AFTER the header, splitting it in half. A FAILURE
  // still speaks, because that one predicts a slow first reply.
  const res = await client.warmupModel(target).catch(() => null);
  if (!res) {
    console.log(chalk.dim('  cold start — the first reply may take a few seconds'));
  }
  console.log();
}

async function showBanner(client: GenesisClient, config: ShellConfig) {
  const backend = await client.detectBackend();

  // Propagate detected backend into config for downstream use
  config.backendType = backend.type;
  config.backendName = backend.name;

  const genesisOnline = backend.type !== 'unknown';
  let llm: string | undefined;
  const serviceLines: { name: string; up: boolean }[] = [];

  // ── Always probe key services independently ────────────────
  // These run regardless of Genesis status so the banner never
  // shows "no services detected" when services ARE actually up.
  // The probe set adapts to the configured endpoints: a remote endpoint
  // probes the PUBLIC authenticated edges it actually talks to, not 127.0.0.1.
  const probes = buildProbes(config, discoverLocalServices());

  const probeResults = await Promise.all(
    probes.map(async (p) => ({ name: p.name, up: await probeHealth(p.url) }))
  );
  for (const r of probeResults) {
    serviceLines.push(r);
  }

  // ── Loaded model + where (from the MicroScheduler backend snapshot) ──
  // Shows the ACTUAL serving model and its location (vLLM/DGX/cloud) instead of
  // a vague "LLM ready", so the banner answers "what model is loaded and where".
  let warmModel: string | undefined;
  const snapshot = await client.getBackendSnapshot().catch(() => null);
  if (snapshot?.backends) {
    const pick = pickServingModel(snapshot.backends);
    if (pick) {
      llm = `${pick.model} @ ${pick.where}`;
      warmModel = pick.model;
    }
  }

  // ── Genesis-enriched status (supplements direct probes) ────
  if (!llm) {
    if (backend.type === 'genesis') {
      if (backend.generationReady === false) {
        llm = 'BUSY (no slots)';
      } else if (backend.generationReady === true) {
        llm = backend.slotsAvailable != null ? `LLM ready (${backend.slotsAvailable} slots)` : 'LLM ready';
      } else if (backend.llmBackend) {
        llm = backend.llmBackend;
      }
    } else if (backend.type === 'adk') {
      llm = backend.llmBackend || undefined;
    }
  }

  // If we still have no LLM info, try MicroScheduler /health directly
  if (!llm) {
    try {
      const llmData = await client.getLLMStatus();
      if (llmData?.model || llmData?.default_model) {
        llm = llmData.model || llmData.default_model;
      }
    } catch {}
  }

  const host = (() => {
    try { return new URL(config.genesisUrl).host; } catch { return config.genesisUrl; }
  })();

  const upCount = serviceLines.filter(s => s.up).length;
  const authUser = config.authUser?.display_name || config.authUser?.username;
  renderBanner({
    genesis: host,
    genesisOnline,
    services: backend.services ?? (upCount > 0 ? upCount : undefined),
    agents: backend.agents,
    llm,
    user: authUser,
    serviceLines,
    backendType: backend.type,
    backendName: backend.name,
  });

  // Warm the orchestrator so the first real turn isn't cold (the "first blip").
  if (genesisOnline) {
    await warmOnConnect(client, config, warmModel);
  }
}

/* ── Non-interactive mode (flag-based) ────────────────────── */

async function runOneShot(client: GenesisClient, config: ShellConfig): Promise<boolean> {
  const args = process.argv.slice(2);

  // Parse flags
  let command: string | undefined;
  let forgeTask: string | undefined;
  let agent: string | undefined;
  let effort: number | undefined;
  let safetyLevel: string | undefined;
  let privateMode = false;
  let chatMessage: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--command' || arg === '-c') && args[i + 1]) {
      // Collect command name + everything after it until next flag as args
      // e.g. -c "run list scale" → command="run list scale"
      //      -c run list scale   → command="run list scale"
      const next = args[++i];
      // If the next arg is already quoted (contains spaces), use it as-is
      // Otherwise collect remaining non-flag args
      if (next.includes(' ')) {
        command = next;
      } else {
        const cmdParts = [next];
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          cmdParts.push(args[++i]);
        }
        command = cmdParts.join(' ');
      }
    } else if ((arg === '--forge' || arg === '-f') && args[i + 1]) {
      forgeTask = args[++i];
    } else if ((arg === '--agent' || arg === '-a' || arg === '--will') && args[i + 1]) {
      agent = args[++i];
    } else if ((arg === '--effort' || arg === '-e') && args[i + 1]) {
      effort = Number(args[++i]);
    } else if ((arg === '--safety' || arg === '-s') && args[i + 1]) {
      safetyLevel = args[++i];
    } else if (arg === '--private') {
      privateMode = true;
    }
  }

  // No flag-based one-shot arguments — return false to fall through
  if (!command && !forgeTask) return false;

  // Override config agent if --agent was provided
  if (agent) config.defaultAgent = agent;

  try {
    if (command) {
      // Execute slash command — split "run list scale" into name="run" cmdArgs="list scale"
      const { getCommand } = await import('./commands.js');
      const spaceIdx = command.indexOf(' ');
      const cmdName = spaceIdx === -1 ? command : command.slice(0, spaceIdx);
      const cmdArgs = spaceIdx === -1 ? '' : command.slice(spaceIdx + 1);
      const cmd = getCommand(cmdName);
      if (cmd) {
        await cmd.handler(client, cmdArgs, config);
      } else {
        console.error(chalk.red(`Unknown command: ${cmdName}`));
        process.exit(1);
      }
    } else if (forgeTask) {
      // Dispatch via forge
      const result = await client.forgeDispatch(forgeTask, {
        agent: agent || config.defaultAgent,
        effort,
      });
      const output = result?.response || result?.result || result?.output;
      if (output) {
        console.log(output);
      } else if (result?.error) {
        console.error(chalk.red(`Error: ${result.error}`));
        process.exit(1);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  return true;
}

/* ── One-shot chat (positional args) ─────────────────────── */

async function oneShotChat(
  client: GenesisClient, config: ShellConfig, message: string, resumeSummary = '',
): Promise<boolean> {
  const fmt = config.outputFormat || 'text';
  const sessionContext = resumeSummary
    ? { summary: resumeSummary, tools_used: [] as string[], model: config.model || '', errors: [] as string[] }
    : undefined;

  const opts = {
    agent: config.defaultAgent, sessionId: config.sessionId, model: config.model,
    effort: config.effort, safetyLevel: config.safetyLevel, privateMode: config.privateMode,
    attachments: config.imageAttachments, sessionContext,
    // The omnibox's "this was typed at a shell prompt" framing rides here rather
    // than in front of the user's words. See the omnibox branch above for the
    // 0/3 -> 3/3 measurement that moved it.
    ...(process.env.AWSH_OMNIBOX_FRAMING
      ? { systemAdditions: [process.env.AWSH_OMNIBOX_FRAMING] } : {}),
  };

  // Collect answer/model/tools/tokens for recording + JSON output.
  let answer = '';
  let model = config.model || '';
  let agent = config.defaultAgent;
  const tools: string[] = [];
  let searchOutput = '';
  let tokens = 0;
  const errors: string[] = [];
  // Omnibox answers are BUFFERED, not streamed: they are ~3 s and a few lines,
  // and buffering lets the shell strip the opener the small model keeps
  // producing despite instructions ("This was a question, not a command.") —
  // measured 1 in 2 runs on the 4B orchestrator. A deterministic strip beats
  // a prompt the model half-obeys.
  const omnibox = !!process.env.AWSH_OMNIBOX_LINE;
  const renderer = (fmt === 'text' && !omnibox) ? createStreamRenderer() : null;
  const started = Date.now();

  try {
    for await (const event of client.streamChat(message, opts)) {
      if (renderer) renderer.onEvent(event);
      if (fmt === 'stream-json') process.stdout.write(JSON.stringify(event) + '\n');

      const d = event.data || {};
      switch (event.type) {
        case 'session_start': if (d.agent) agent = d.agent; break;
        case 'token': answer += (d.t || d.token || ''); break;
        case 'message': if (!answer) answer = String(d.content || d.message || ''); break;
        // Terminal answer events are AUTHORITATIVE — overwrite the token
        // accumulation (eager streaming emits TWO segments worth of tokens, so
        // the concatenation would otherwise double the answer).
        case 'answer': case 'final_answer': {
          const t = d.answer || d.content || d.message; if (t) answer = String(t); break;
        }
        case 'tool_call':
          for (const t of (d.tools || d.tool_calls || [])) tools.push(t.name || t.function?.name || 'tool');
          break;
        // The SOURCES come from the TOOL OUTPUT, never from the prose.
        // Measured 2026-08-23: the search returned five dated stories with
        // real URLs and the 4B orchestrator answered with a list of outlet
        // names that were not among them. Good retrieval, discarded by
        // synthesis -- which reads to the user as a bad search.
        case 'tool_result':
          for (const r of (d.results || [])) {
            if (!r?.success) continue;
            if (!/(^|_)(search|research|find)/.test(String(r.tool || ''))) continue;
            searchOutput += (searchOutput ? String.fromCharCode(10, 10) : '') + String(r.output || '');
          }
          break;
        case 'llm_done': case 'llm_end':
          if (d.model_used || d.model) model = d.model_used || d.model;
          tokens += Number(d.tokens_used || d.tokens || 0); break;
        case 'complete': case 'done':
          if (d.model) model = d.model;
          if (d.content) answer = String(d.content); break;
        case 'error': case 'llm_error': errors.push(String(d.message || d.error || 'error')); break;
      }
    }
    if (renderer) renderer.finish();
    if (renderer && answer === '') answer = renderer.getContent();
    if (omnibox && fmt === 'text') {
      const { stripOmniboxOpener } = await import('./situation.js');
      const { linkifyTerminal } = await import('./renderer.js');
      // A cited source you cannot click is a citation you cannot follow.
      // The model emits markdown links about half the time despite being
      // told not to, so the reader saw a literal [CNN](https://...); this
      // turns both that and any bare URL into an OSC 8 hyperlink, and
      // degrades to readable text on a terminal without OSC 8.
      const text = linkifyTerminal(stripOmniboxOpener(answer));
      if (text) process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
      else process.stdout.write(chalk.dim('  (no answer from the agent — try: awsh "' +
                                          (process.env.AWSH_OMNIBOX_LINE || '') + '")\n'));
      // Printed even when the prose already cites them: a duplicated source is
      // noise, a source you cannot click is a dead end, and only one of those
      // is recoverable by the reader.
      if (searchOutput) {
        const { parseSearchHits, renderSources } = await import('./renderer.js');
        const block = renderSources(parseSearchHits(searchOutput));
        if (block) process.stdout.write(String.fromCharCode(10) + block + String.fromCharCode(10));
      }
      process.stdout.write(chalk.dim(`  ⬢ ${agent}  ·  ${((Date.now() - started) / 1000).toFixed(1)}s\n`));
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return false;
    const msg = err.message || 'unknown error';
    if (fmt === 'json') { process.stdout.write(JSON.stringify({ ok: false, error: msg, session_id: config.sessionId }) + '\n'); return false; }
    if (msg.includes('took too long')) {
      console.error(chalk.yellow(msg));
      console.error(chalk.dim('Try: docker compose -f docker-compose.aitheros.yml --profile chat-full up -d'));
    } else if (msg.includes('Cannot connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error(chalk.red(`Backend not reachable at ${config.genesisUrl}`));
      console.error(chalk.dim('Start Genesis: docker compose -f docker-compose.aitheros.yml --profile chat-minimal up -d'));
      console.error(chalk.dim('  Or ADK:    adk serve --identity <agent>'));
    } else {
      console.error(chalk.red(`Error: ${msg}`));
    }
    return false;
  }

  // Persist the turn (local transcript + remote sync) so --continue/--resume work.
  const recordedUser = process.env.AWSH_OMNIBOX_LINE || message;
  try { recordTurn(config.sessionId, agent, recordedUser, answer, { model, tools, tokens }); } catch { /* */ }

  if (fmt === 'json') {
    process.stdout.write(JSON.stringify({
      ok: errors.length === 0, answer, model, agent,
      session_id: config.sessionId, tools, tokens,
      errors: errors.length ? errors : undefined,
    }) + '\n');
  }
  return errors.length === 0;
}

/* ── Help ───────────────────────────────────────────────────── */

function printUsage() {
  console.log(`
${chalk.bold('aither')} \u2014 AitherOS interactive terminal

${chalk.bold('Usage:')}
  aither                          Start interactive REPL
  aither "message"                One-shot: send, print, exit
  aither -c <command>             Execute a slash command and exit
  aither -f <task>                Forge dispatch and exit
  aither --help                   Show this help
  aither --version                Show version

${chalk.bold('One-shot flags:')}
  -c, --command <cmd>             Execute slash command (status, agents, services, gaming, apps, etc.)
  -f, --forge <task>              Dispatch task via Forge
  -a, --agent <name>              Agent for chat/forge (default: aither)
      --will <name>               Alias for --agent (e.g. --will iris)
  -e, --effort <N>                Effort level 1-10 (higher = deeper/quality)
  -s, --safety <level>            Safety: unrestricted, casual, professional
      --private                   Private mode (prompt hidden from logs/training)
  -i, --image <path>              Attach image for vision analysis (repeatable)

${chalk.bold('Portable gateway mode (run anywhere with internet + an aither_sk_live_* key):')}
      --gateway [url]             Point inference + MCP tools at the public gateway
                                  (default https://mcp.aitherium.com); forces raw inference
      --inference-mode <mode>     auto (default) | genesis (orchestrated pipeline) |
                                  raw (bypass Genesis → model direct via gateway/MicroScheduler)
                                  Env: AITHER_GATEWAY_URL, AITHER_INFERENCE_MODE, AITHER_MCP_URL,
                                  AITHER_LLM_URL. Auth via your aither_sk_live_* key (aither login).

${chalk.bold('Direct provider (no fleet required — works when Genesis/MCP are down):')}
      --deepseek [variant]        Talk straight to api.deepseek.com. flash (default) |
                                  reasoner | <model>. Needs DEEPSEEK_API_KEY (or
                                  AITHER_DEEPSEEK_API_KEY). Pins the endpoint: no failover.
      --kimi, --moonshot [var]    Talk straight to api.moonshot.ai. k3 | max | <model>.
                                  Needs MOONSHOT_API_KEY. Also pins the endpoint.

${chalk.bold('Headless / scripting:')}
  -p, --print [prompt]            Headless: read prompt from arg and/or piped stdin, print, exit
      --output-format <fmt>       text (default) | json | stream-json
      --json                      Shorthand for -p --output-format json
  Exit code 0 on success, 1 on error.  Examples:
    aither -p "summarize" < notes.md
    cat error.log | aither -p "what failed?" --output-format json
    git diff | aither -p "review this diff" --json

${chalk.bold('Sessions (persistent transcripts in ~/.aither/sessions):')}
      --continue, -C              Resume the most recent conversation
      --resume <id>               Resume a specific session id (replays context)
      --session <id>              Alias for --resume
  In-shell: /chats [resume|delete <id>] · /export [path] [--json] · /copy · /tokens · /rewind [N] · /compact

${chalk.bold('Auth:')}
      --login                     Device-flow sign-in (portal.aitherium.com/link)
      --key <token>               Authenticate with an API key
  In-shell: /login · /whoami · /logout   (remote endpoints require sign-in)

${chalk.bold('TUI:')}
  Interactive mode defaults to the blessed 3-pane TUI: seamless answer pane (left) +
  collapsible per-turn trace threads (right; Ctrl+E expand/collapse, click a header to toggle).
  AITHER_TUI=0 falls back to the native readline shell (line editing, history, paste).
  AITHER_STEER=1 enables the fixed bottom steering bar (limits terminal scrollback).

${chalk.bold('Quick actions:')}
  aither -c gaming                Toggle gaming mode (free VRAM for games)
  aither -c "gaming on"           Activate gaming mode
  aither -c apps                  Show all AitherOS app statuses
  aither -c "apps install desktop"  Install AitherDesktop
  aither -c "apps start veil"    Start AitherVeil dashboard

${chalk.bold('Examples:')}
  aither -c status                Print system status and exit
  aither -c agents                List agents and exit
  aither -f "refactor auth module" -a demiurge -e 7
  aither "What services are running?"
  aither --will iris "draw a cyberpunk cityscape"
  aither --will iris -e 8 "masterpiece portrait, 8k"
  aither --will iris --safety unrestricted --private "private prompt"
  aither --will saga "tell me about the ancient ruins"
  aither --image screenshot.png "what's in this image?"
  aither -i photo.jpg -i diagram.png "compare these two"

${chalk.bold('Environment variables:')}
  AITHER_API_URL                  Backend URL (Genesis or ADK server)
  AITHER_GENESIS_URL              Legacy alias for AITHER_API_URL
  AITHER_AGENT                    Default agent (default: aither)
  AITHER_MODEL                    LLM model override

${chalk.bold('Config file:')}
  ~/.aither/shell.yaml            Optional (api_url, default_agent, model)

${chalk.bold('Interactive commands:')}
  /help        Show all commands       /agents      List agents
  /status      System status           /services    List services
  /forge       Dispatch to Forge       /logs        View logs
  /gaming      Toggle gaming mode      /apps        Manage AitherOS apps
  /sessions    List recent sessions    /resume      Resume a session
  /model       Show/set model          /clear       Clear screen
  exit         Quit

${chalk.bold('Routing:')}
  @agent_name message             Route to specific agent
  message                         Route to default agent
`);
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
