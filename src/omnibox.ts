/**
 * omnibox.ts — the line you type is a QUESTION, not necessarily a command.
 *
 * WHY THIS EXISTS. A shell has exactly one response to a line it does not
 * recognise: `command not found`. So the moment you want to look something up you
 * leave the terminal for a browser and lose the directory, the environment and the
 * session you were already in — when everything needed to answer you was right
 * there. This module makes an unrecognised line reach an agent instead.
 *
 * ── THE MEASUREMENT THAT SHAPES THE WHOLE DESIGN ─────────────────────────────
 * PowerShell runs MODULE AUTO-DISCOVERY *before* it raises CommandNotFoundAction:
 * on a miss it scans every directory on $env:PSModulePath looking for a module
 * that exports that name. The handler installed here therefore cannot be faster
 * than that scan, however it is written.
 *
 * Measured 2026-08-20, `pwsh -NoProfile`, same missing command, same box:
 *
 *     PSModulePath includes a repo ROOT (100 dirs) :  > 60,000 ms  (timed out)
 *     PSModulePath without it                      :        81 ms
 *
 * A ~750x penalty on EVERY typo, and it is invisible: nothing errors, nothing
 * logs, the command eventually fails exactly as expected — it just takes a minute
 * to say so. So `judgeOmnibox()` is not a nicety bolted on the side: an omnibox
 * installed over a pathological PSModulePath is a terminal that hangs for a minute
 * before answering, which is strictly WORSE than `command not found`.
 *
 * So the emitted snippet WARNS at install time, naming the offending entry, and
 * `awsh doctor` measures a real miss and judges it against MISS_BUDGET_MS. The
 * install-time check is STRUCTURAL (counting directories, ~40 ms) rather than
 * timed, because measuring a miss would cost the very 60 s being warned about --
 * on every single shell start.
 *
 * This docstring previously claimed `init` REFUSED to install in that state. It
 * did not: judgeOmnibox() was reachable only from the test suite, so 23 green
 * tests covered a feature production never ran. That is the same silent-no-op
 * this module's own guards exist to prevent, and it is why the claim now
 * describes a code path you can follow.
 *
 * ── THE GUARD THAT WAS WRONG, AND THE MEASUREMENT THAT REPLACED IT ───────────
 * CommandNotFoundAction is a blunt instrument: it also fires for
 * `Get-Command foo -ErrorAction SilentlyContinue`, which is how every script tests
 * whether a tool is installed. There can be hundreds per profile load, and
 * answering them would fire an agent request per probe — invisibly, and billed.
 *
 * The obvious guard is a call-stack depth check, and it DOES NOT WORK. Measured:
 *
 *     lookup                                  CommandOrigin   depth
 *     Get-Command foo -EA SilentlyContinue    Runspace          2
 *     foo              (typed at top level)   Runspace          2
 *     foo              (inside a scriptblock) Internal          3
 *     foo              (inside a function)    Internal          3
 *
 * Depth is 2 for BOTH the probe and the real invocation, so a depth rule lets
 * everything through while looking like a filter — a hole that would have shipped
 * silently. `CommandOrigin` is the real discriminator: `Internal` covers every
 * lookup made from inside a function, script, module or profile, which is where
 * essentially all tool probes live. What remains is a human literally typing
 * `Get-Command foo` at the prompt, which is rare and cheap.
 */

export type InitShell = 'pwsh' | 'powershell' | 'bash' | 'zsh';

/** Shells we can emit an integration for, in the spelling `init` accepts. */
export const INIT_SHELLS: readonly InitShell[] = ['pwsh', 'powershell', 'bash', 'zsh'];

/**
 * Slowest acceptable command-miss resolution before the omnibox is worth having.
 *
 * 81 ms is the healthy figure measured above; 1500 ms is generous headroom for a
 * cold filesystem cache and a slower disk. Past this a human reads the terminal as
 * hung, and the omnibox gets blamed for a stall that predates it.
 */
export const MISS_BUDGET_MS = 1500;

/**
 * The PowerShell half.
 *
 * Two parts of the mechanism are non-obvious and get "simplified" into breakage:
 *
 * 1. The handler receives the command NAME only — never the rest of the line. The
 *    way to recover the arguments is to hand PowerShell a scriptblock through
 *    `$EventArgs.CommandScriptBlock`; PowerShell then invokes THAT with the
 *    remaining arguments in `$args`. So `vaporwave aesthetic music` arrives as
 *    CommandName='vaporwave' plus $args=('aesthetic','music'), and the full line
 *    is reassembled inside the block. Reading `$MyInvocation.Line` does not work —
 *    by the time the handler runs it describes the handler.
 *
 * 2. `.GetNewClosure()` is load-bearing. Without it the scriptblock captures
 *    nothing, `$CommandName` and `$exePath` are empty at invocation time, and it
 *    fails as an EMPTY QUERY rather than as an error — the worst shape of bug,
 *    because the agent dutifully answers a question nobody asked.
 */
function pwshSnippet(): string {
  return `# ── awsh omnibox ────────────────────────────────────────────────────────
# Installed by:  awsh init pwsh | Out-String | Invoke-Expression
# Off for one session:  $env:AWSH_OMNIBOX = '0'
# Remove for good:      delete this block from your profile.
if (-not $global:__AwshOmnibox) {
    $global:__AwshOmnibox = $true

    # Keep whatever hook was already installed. Another tool may own this, and
    # silently replacing it is how two features that both "work" delete each other.
    $global:__AwshPrevCNF = $ExecutionContext.InvokeCommand.CommandNotFoundAction

    $ExecutionContext.InvokeCommand.CommandNotFoundAction = {
        param($CommandName, $EventArgs)

        $fallback = {
            if ($global:__AwshPrevCNF) { & $global:__AwshPrevCNF $CommandName $EventArgs }
        }

        # 1. Kill switch first, so a wedged omnibox is one export away from gone
        #    without anyone having to edit a profile under duress.
        if ($env:AWSH_OMNIBOX -eq '0') { & $fallback; return }

        # 2. Re-entrancy. awsh shells out; if one of those misses we must not
        #    recurse into the agent about our own tooling.
        if ($global:__AwshBusy) { & $fallback; return }

        # 3. Top-level lookups ONLY. This is the guard that decides the cost of the
        #    whole feature. 'Get-Command foo -ErrorAction SilentlyContinue' raises
        #    CommandNotFound and there can be hundreds per profile load; every one
        #    of those is made from inside a script or function, so CommandOrigin is
        #    'Internal'. A call-stack DEPTH check cannot do this job — measured, it
        #    is 2 for both the probe and the real thing. Do not "simplify" this back.
        if ("$($EventArgs.CommandOrigin)" -ne 'Runspace') { & $fallback; return }

        # 4. A missing command inside a non-interactive session is a BUG, and
        #    answering it would hide the bug behind a plausible paragraph.
        if (-not $global:__AwshInteractive) { & $fallback; return }

        # 5. A path-shaped name is a mistake about a FILE, not a question.
        if ($CommandName -match '[\\\\/]' -or $CommandName -match '^\\.' -or
            $CommandName -match '\\.[A-Za-z0-9]{1,4}$') { & $fallback; return }

        # 6. If awsh is not installed, behave EXACTLY as before. A missing
        #    omnibox must never swallow the error it was meant to improve on.
        # FIRST match only. Get-Command returns EVERY awsh on PATH, and with two
        # shims installed (npm global + ~/bin, measured 2026-08-23) $exe.Source
        # became two paths joined by a space -- which PowerShell then tried to
        # run as one command and failed with 'not recognized'. The omnibox was
        # dead on every typo while 'Get-Command awsh' looked perfectly healthy.
        $exe = Get-Command awsh -CommandType Application -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if (-not $exe) { & $fallback; return }
        $exePath = $exe.Source

        $EventArgs.CommandScriptBlock = {
            # Undo PowerShell's implicit Get- prefix. A bare missing word is
            # retried as get-<word> BEFORE the handler is reached, so typing
            # 'vaporwave' arrives here as 'get-vaporwave' -- and the whole point
            # of this feature is to answer what the human actually typed.
            # Measured 2026-08-21: the agent was asked about "get-vaporwave".
            # Only strip when the remainder carries no further hyphen, which is
            # the shape PowerShell injects; a real Get-Foo-Bar is left alone.
            $name = $CommandName
            if ($name -match '^(?i)get-([^-]+)$') { $name = $Matches[1] }
            $line = (@($name) + @($args)) -join ' '
            $global:__AwshBusy = $true
            # This shell's PID keys ONE transcript per terminal window, so a
            # follow-up line ("how do you know that?") lands on the agent with
            # the previous exchange in context instead of as a cold question.
            $env:AWSH_OMNIBOX_SESSION = "$PID"
            try     { & $exePath ask --omnibox -- $line }
            finally { $global:__AwshBusy = $false }
        }.GetNewClosure()
        $EventArgs.StopSearch = $true
    }

    # ── install-time health check ────────────────────────────────────────────
    # PowerShell scans every PSModulePath entry for a module exporting a missing
    # name BEFORE CommandNotFoundAction runs, so a source tree on that path taxes
    # EVERY typo. Measured on the author's box: >60,000 ms with a repo root on it
    # vs 81 ms without. Installing the omnibox over that puts an answer behind an
    # existing stall, which is strictly worse than a plain command-not-found.
    #
    # Structural, not timed: counting directories is ~40 ms, whereas MEASURING a
    # miss would cost the very 60 s being warned about -- at every shell start.
    $global:__AwshSlowPaths = @()
    foreach ($e in ($env:PSModulePath -split [IO.Path]::PathSeparator | Where-Object { $_ })) {
        try {
            if (-not [IO.Directory]::Exists($e)) { continue }
            $dirs = @([IO.Directory]::GetDirectories($e)).Count
            if ($dirs -lt 20) { continue }
            $manifests = 0
            foreach ($d in [IO.Directory]::GetDirectories($e)) {
                $leaf = [IO.Path]::GetFileName($d)
                if ([IO.File]::Exists([IO.Path]::Combine($d, "$leaf.psd1"))) { $manifests++ }
            }
            if ($manifests -ge [Math]::Max(2, $dirs * 0.25)) { continue }
            $global:__AwshSlowPaths += "$e ($dirs dirs, $manifests module manifests)"
        } catch { }
    }
    if ($global:__AwshSlowPaths.Count -gt 0) {
        Write-Warning ("awsh omnibox: PSModulePath carries what looks like a SOURCE TREE, " +
            "so every missing command is scanned against it before the omnibox can run. " +
            "Measured cost of this shape: ~60s per typo instead of ~81ms. Offending: " +
            ($global:__AwshSlowPaths -join '; ') +
            " -- point PSModulePath at a directory that actually holds modules.")
    }

    # Decided ONCE, at install time, rather than per miss: was this process started
    # to run a script (-File / -Command / -EncodedCommand)? Those are automation,
    # and automation must keep getting the honest error.
    $global:__AwshCli = [Environment]::GetCommandLineArgs()
    $global:__AwshInteractive =
        # -NoExit means the shell STAYS at a prompt after running whatever it was
        # given, which is the definition of an interactive session and is exactly
        # how a terminal profile installs a startup hook. It must win over the
        # -Command test below, because the two appear TOGETHER in that install.
        #
        # This is not hypothetical: on a machine with Controlled Folder Access
        # enabled, ~/Documents is unwritable and the PowerShell profile cannot be
        # edited at all -- the write is refused as a bizarre "could not find
        # file" on a CREATE, with no error a caller would recognise. The only
        # remaining user-level auto-load path is the terminal profile's own
        # command line, which spells this
        #     pwsh -NoExit -Command ". $HOME/.aither/awsh-omnibox.ps1"
        # so without this branch the sole workable install would silently turn
        # the feature off at the moment it installed it.
        if ($global:__AwshCli | Where-Object { $_ -match '^-(?i)noe' }) { $true }
        else {
            -not ($global:__AwshCli |
                  Where-Object { $_ -match '^-(c|Command|f|File|e|EncodedCommand)$' })
        }
}
`;
}

/**
 * The bash/zsh half.
 *
 * Both shells hand the handler the WHOLE line already (name + args as "$@"), so
 * there is no closure trick to perform, and neither shell calls these hooks for a
 * `command -v` probe — so the expensive-probe problem the PowerShell side has
 * simply does not exist here.
 *
 * The hook name differs by ONE WORD between them and getting it wrong fails
 * silently: the shell ignores an unknown function name and prints its own error,
 * which reads as "the integration did nothing". Pinned in selfTest().
 */
function posixSnippet(shell: 'bash' | 'zsh'): string {
  const fn = shell === 'bash' ? 'command_not_found_handle' : 'command_not_found_handler';
  return `# ── awsh omnibox ────────────────────────────────────────────────────────
# Installed by:  eval "$(awsh init ${shell})"
# Off for one session:  export AWSH_OMNIBOX=0
${fn}() {
    # Interactive humans only — a missing command in a script is a bug. $- carries
    # the interactive flag; same reasoning as the PowerShell guard 4.
    case $- in *i*) ;; *) echo "$1: command not found" >&2; return 127 ;; esac

    [ "\${AWSH_OMNIBOX:-1}" = "0" ] && { echo "$1: command not found" >&2; return 127; }
    [ -n "\${__AWSH_BUSY:-}" ]      && { echo "$1: command not found" >&2; return 127; }

    # A path-shaped name is a mistake about a FILE, not a question.
    case "$1" in */*|.*|*.*) echo "$1: command not found" >&2; return 127 ;; esac

    # Absent awsh must behave exactly as before.
    command -v awsh >/dev/null 2>&1 || { echo "$1: command not found" >&2; return 127; }

    __AWSH_BUSY=1
    AWSH_OMNIBOX_SESSION="$$" awsh ask --omnibox -- "$*"
    __awsh_rc=$?
    unset __AWSH_BUSY
    return $__awsh_rc
}
`;
}

/** Emit the shell integration for `awsh init <shell>`. */
export function omniboxInitScript(shell: InitShell): string {
  if (shell === 'pwsh' || shell === 'powershell') return pwshSnippet();
  return posixSnippet(shell);
}

export interface OmniboxVerdict {
  ok: boolean;
  missMs: number;
  /** PSModulePath entries that look like a source tree rather than a module dir. */
  offenders: string[];
  reason: string;
  remedy?: string;
}

/**
 * A PSModulePath entry is legitimate when it CONTAINS module directories. A repo
 * root contains a hundred directories that are not modules, and PowerShell stats
 * its way through every one of them on every miss.
 *
 * Deliberately conservative: flagged only when BOTH large and manifest-poor. A big
 * legitimate module directory (the Windows one holds ~90) must never be flagged —
 * a check that cries wolf gets ignored, which is how the real offender keeps its
 * cover.
 */
export function classifyModulePath(
  entry: string,
  dirCount: number,
  manifestCount: number,
): boolean {
  if (dirCount < 20) return false;                                  // cost negligible
  if (manifestCount >= Math.max(2, dirCount * 0.25)) return false;  // really a module dir
  return true;
}

export function judgeOmnibox(missMs: number, offenders: string[]): OmniboxVerdict {
  if (missMs >= 0 && missMs <= MISS_BUDGET_MS) {
    return { ok: true, missMs, offenders, reason: `command-miss resolves in ${missMs} ms` };
  }
  const worst = offenders.length ? offenders.join(', ') : '(none identified)';
  return {
    ok: false,
    missMs,
    offenders,
    reason:
      `a missed command takes ${missMs} ms to resolve, over the ${MISS_BUDGET_MS} ms ` +
      `budget. PowerShell scans every PSModulePath entry for a module exporting the ` +
      `name BEFORE the omnibox hook can run, so installing it here would put an answer ` +
      `behind an existing stall rather than removing the stall.`,
    remedy:
      `Take the source tree(s) off PSModulePath and point it at the directory that ` +
      `actually holds modules. Offending entries: ${worst}`,
  };
}

/** `--self-test` — every claim above, driven by numbers instead of a subprocess. */
export function selfTest(): string[] {
  const failures: string[] = [];

  // 1. A healthy box installs; the measured pathological one refuses WITH a remedy.
  if (!judgeOmnibox(81, []).ok) failures.push('81 ms should be judged installable');
  const bad = judgeOmnibox(60000, ['D:\\AitherOS-Fresh']);
  if (bad.ok) failures.push('60000 ms must NOT be judged installable');
  if (!bad.remedy) failures.push('a refusal with no remedy is a dead end, not a verdict');

  // 2. The boundary is a boundary in both directions.
  if (!judgeOmnibox(MISS_BUDGET_MS, []).ok) failures.push('budget itself must pass');
  if (judgeOmnibox(MISS_BUDGET_MS + 1, []).ok) failures.push('one over budget must fail');

  // 3. classifyModulePath must catch the real offender and spare a real module dir.
  if (classifyModulePath('C:\\WINDOWS\\...\\Modules', 90, 88)) {
    failures.push('a genuine module directory must not be flagged');
  }
  if (!classifyModulePath('D:\\AitherOS-Fresh', 100, 1)) {
    failures.push('a source tree on PSModulePath must be flagged');
  }
  if (classifyModulePath('C:\\some\\dir', 5, 0)) {
    failures.push('a small directory must not be flagged');
  }

  // 4. Every snippet keeps the kill switch and the absent-awsh fallback. Those
  //    two are what make this safe to put in a profile; a refactor dropping either
  //    leaves a terminal with no way back.
  for (const sh of INIT_SHELLS) {
    const s = omniboxInitScript(sh as InitShell);
    if (!s.includes('AWSH_OMNIBOX')) failures.push(`${sh}: no kill switch`);
    if (!/awsh/.test(s)) failures.push(`${sh}: never invokes awsh`);
  }

  // 5. The three lines whose absence fails SILENTLY rather than loudly.
  const ps = pwshSnippet();
  if (!ps.includes('GetNewClosure')) {
    failures.push('pwsh snippet lost GetNewClosure — args would arrive empty');
  }
  if (!/Get-Command awsh[^\n]*\n\s*Select-Object -First 1/.test(ps)) {
    failures.push('pwsh snippet lost Select-Object -First 1 — two awsh shims on PATH ' +
                  'make $exe.Source two paths and every invocation fails');
  }
  if (!ps.includes('AWSH_OMNIBOX_SESSION = "$PID"')) {
    failures.push('pwsh snippet lost the per-terminal session id — every line becomes a cold one-shot');
  }
  if (!posixSnippet('bash').includes('AWSH_OMNIBOX_SESSION="$$"')) {
    failures.push('posix snippet lost the per-terminal session id');
  }
  if (!ps.includes('CommandOrigin')) {
    failures.push('pwsh snippet lost the CommandOrigin guard — every Get-Command ' +
                  'probe in every script would reach the agent');
  }
  if (/PSCallStack.*-gt/.test(ps)) {
    failures.push('pwsh snippet reintroduced the call-stack depth guard, which was ' +
                  'MEASURED not to distinguish a probe from a real invocation');
  }
  if (!posixSnippet('bash').includes('command_not_found_handle(')) {
    failures.push('bash hook misnamed');
  }
  if (!posixSnippet('zsh').includes('command_not_found_handler(')) {
    failures.push('zsh hook misnamed');
  }

  return failures;
}

/**
 * The Windows Terminal install payload.
 *
 * WHY THIS IS A FUNCTION WITH A TEST INSTEAD OF A LINE IN A RUNBOOK.
 * The obvious install -- appending to the PowerShell profile -- is IMPOSSIBLE on
 * a machine with Controlled Folder Access enabled: ~/Documents is unwritable,
 * and the refusal presents as "Could not find file" on a CREATE while
 * Add-Content reports success. So the fallback is the terminal profile's own
 * command line, and that string is parsed TWICE -- once as JSON, then split
 * into argv by Windows before pwsh ever sees it.
 *
 * The first version used escaped double quotes. That is valid JSON and it
 * SURVIVED validation, then arrived at the parser unquoted and every new tab
 * opened with
 *     ParserError: You must provide a value expression following the '/' operator
 * -- i.e. the check that passed was checking the wrong layer. So the payload
 * contains NO double quotes and NO backslashes at all: single quotes need no
 * JSON escaping and survive the argv split intact.
 */
export function terminalCommandlineSuffix(): string {
  return "; $o = ($HOME + '/.aither/awsh-omnibox.ps1'); if (Test-Path $o) { . $o }";
}

/** Is this commandline already carrying the omnibox install? */
export function terminalCommandlineHasOmnibox(commandline: string): boolean {
  return commandline.includes('awsh-omnibox.ps1');
}

/**
 * Append the install to an existing Windows Terminal commandline, idempotently.
 * Returns the unchanged input when it is already installed.
 */
export function withTerminalOmnibox(commandline: string): string {
  if (terminalCommandlineHasOmnibox(commandline)) return commandline;
  return commandline + terminalCommandlineSuffix();
}
