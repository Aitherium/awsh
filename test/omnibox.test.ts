/**
 * Tests for the omnibox — the hook that turns an unrecognised line into a question.
 *
 * Every assertion here is pinned to a MEASUREMENT taken on 2026-08-20 rather than
 * to an opinion, because two of the design's load-bearing facts are counter-
 * intuitive enough that a future refactor will otherwise "simplify" them away:
 *
 *   1. A missed command cost >60,000 ms with a repo root on PSModulePath and 81 ms
 *      without it. PowerShell scans PSModulePath for a module exporting the name
 *      BEFORE the hook can run, so the hook can never be faster than that scan.
 *
 *   2. Call-stack DEPTH does not distinguish a `Get-Command foo -EA
 *      SilentlyContinue` probe from a command a human typed — measured 2 for both.
 *      `CommandOrigin` does (Runspace vs Internal).
 *
 * The tests that matter most are the mutation guards at the bottom: they assert
 * the checks can still FAIL, so a rule that quietly stops asserting anything gets
 * caught rather than reading as a clean pass.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  selfTest,
  terminalCommandlineSuffix,
  withTerminalOmnibox,
  judgeOmnibox,
  classifyModulePath,
  omniboxInitScript,
  INIT_SHELLS,
  MISS_BUDGET_MS,
  type InitShell,
} from '../src/omnibox.js';

describe('omnibox self-test', () => {
  test('reports zero failures on the shipped module', () => {
    const failures = selfTest();
    assert.deepEqual(failures, [], `self-test failures:\n  ${failures.join('\n  ')}`);
  });

  test('actually asserts something (a self-test that checks nothing is not a gate)', () => {
    // The failure mode this guards: selfTest() returning [] because it stopped
    // running its checks, which is indistinguishable from [] because everything
    // passed. Drive it with a value we KNOW must fail.
    assert.equal(judgeOmnibox(999_999, []).ok, false);
    assert.equal(judgeOmnibox(10, []).ok, true);
  });
});

describe('judgeOmnibox — is the omnibox worth installing here', () => {
  test('the healthy measured figure (81 ms) installs', () => {
    assert.equal(judgeOmnibox(81, []).ok, true);
  });

  test('the pathological measured figure (60 s) refuses', () => {
    const v = judgeOmnibox(60_000, ['D:\\AitherOS-Fresh']);
    assert.equal(v.ok, false);
    // A refusal with no remedy is a dead end, not a verdict.
    assert.ok(v.remedy, 'refusal must carry a remedy');
    assert.match(v.remedy!, /AitherOS-Fresh/, 'remedy must NAME the offending path');
  });

  test('the budget is a boundary in both directions', () => {
    assert.equal(judgeOmnibox(MISS_BUDGET_MS, []).ok, true, 'the budget itself passes');
    assert.equal(judgeOmnibox(MISS_BUDGET_MS + 1, []).ok, false, 'one over fails');
  });

  test('a refusal explains WHY the hook cannot fix it', () => {
    // The non-obvious part users need told: this is not the omnibox being slow,
    // it is a stall that happens before the omnibox gets to run at all.
    assert.match(judgeOmnibox(60_000, ['X']).reason, /BEFORE the omnibox/i);
  });
});

describe('classifyModulePath — which PSModulePath entries are the problem', () => {
  test('flags a source tree (100 dirs, ~no module manifests)', () => {
    assert.equal(classifyModulePath('D:\\AitherOS-Fresh', 100, 1), true);
  });

  test('does NOT flag a real module directory (Windows ships ~90)', () => {
    // A rule that floods gets switched off, and then the real offender keeps its
    // cover. This is the more important half of the rule.
    assert.equal(classifyModulePath('C:\\WINDOWS\\...\\Modules', 90, 88), false);
  });

  test('does NOT flag a small directory either way', () => {
    assert.equal(classifyModulePath('C:\\some\\dir', 5, 0), false);
  });

  test('the threshold is proportional, not a magic constant', () => {
    // 40 dirs / 10 manifests is exactly 25% → still a module dir.
    assert.equal(classifyModulePath('x', 40, 10), false);
    // 40 dirs / 9 manifests is under → a source tree wearing a module dir's hat.
    assert.equal(classifyModulePath('x', 40, 9), true);
  });
});

describe('emitted shell integrations', () => {
  for (const shell of INIT_SHELLS) {
    test(`${shell}: carries the kill switch and invokes awsh`, () => {
      const s = omniboxInitScript(shell as InitShell);
      assert.match(s, /AWSH_OMNIBOX/, 'no kill switch — no way back from a wedged hook');
      assert.match(s, /awsh/, 'never invokes awsh');
    });

    test(`${shell}: refuses to swallow the error when awsh is absent`, () => {
      // The rule: a missing omnibox must behave EXACTLY as the shell did before.
      const s = omniboxInitScript(shell as InitShell);
      assert.match(s, /command not found|PrevCNF/,
        'must fall back to the original not-found behaviour');
    });
  }

  test('pwsh: undoes the implicit Get- prefix PowerShell adds', () => {
    // MEASURED 2026-08-21, in a real interactive runspace: typing `vaporwave`
    // reached the hook as CommandName='get-vaporwave', because PowerShell
    // retries a bare missing word with an implicit Get- verb BEFORE
    // CommandNotFoundAction is raised. The agent was therefore asked about a
    // command the human never typed -- and "answer what I typed" is the entire
    // feature. It is invisible to every other check: the hook fires, the agent
    // answers, the exit code is 0, and only the WORD is wrong.
    const s = omniboxInitScript('pwsh');
    assert.match(s, /get-\(\[\^-\]\+\)\$/,
      'the implicit Get- prefix is not stripped — the agent sees get-<word>');
  });

  test('the Get- strip is narrow: it must not eat a real Get-Foo-Bar', () => {
    // Both directions. A rule that stripped every leading Get- would rewrite a
    // genuine cmdlet typo into a different question, which is a worse failure
    // than the one being fixed because it looks like the agent misunderstood.
    // This ports the emitted PowerShell regex to JS and asserts its semantics.
    const strip = (name: string) => {
      const m = /^get-([^-]+)$/i.exec(name);
      return m ? m[1] : name;
    };
    assert.equal(strip('get-vaporwave'), 'vaporwave', 'the injected shape must be undone');
    assert.equal(strip('Get-Vaporwave'), 'Vaporwave', 'PowerShell is case-insensitive here');
    assert.equal(strip('Get-Foo-Bar'), 'Get-Foo-Bar', 'a real hyphenated name is left alone');
    assert.equal(strip('vaporwave'), 'vaporwave', 'an unprefixed name is untouched');
  });

  test('pwsh: -NoExit counts as interactive even alongside -Command', () => {
    // Without this the ONLY workable install on this machine disables the
    // feature at the moment it installs it.
    //
    // MEASURED 2026-08-21: Controlled Folder Access is enabled here, so
    // ~/Documents is unwritable and the PowerShell profile cannot be edited at
    // all -- and the refusal presents as "Could not find file" on a CREATE, so
    // Add-Content reports success and the profile is silently unchanged. Two
    // separate installs were verified "done" that way before anyone read the
    // file back. The remaining user-level auto-load path is the terminal
    // profile's own command line, which is
    //     pwsh -NoExit -Command ". $HOME/.aither/awsh-omnibox.ps1"
    // -- i.e. it carries -Command, which the automation guard rejects.
    //
    // -NoExit means the shell STAYS at a prompt, which is what interactive
    // means, so it must win over the -Command test rather than sit beside it.
    const s = omniboxInitScript('pwsh');
    // Comments must be stripped: this block DOCUMENTS the trap at length, and
    // matching the explanation instead of the code is how a gate passes on a
    // reverted fix.
    const NL = String.fromCharCode(10);
    const gate = s
      .slice(s.lastIndexOf('$global:__AwshInteractive'))
      .split(NL).filter((l) => !l.trim().startsWith('#')).join(' ');
    assert.match(gate, /noe/i,
      '-NoExit is not treated as interactive — the terminal-profile install is inert');
    // Order matters, not just presence: the -NoExit branch must be consulted
    // BEFORE the -Command rejection, or the two cancel out.
    assert.ok(gate.search(/noe/i) < gate.indexOf('EncodedCommand'),
      '-NoExit must be checked before the -Command/-File rejection');
  });

  test('pwsh: keeps GetNewClosure (its absence fails SILENTLY as an empty query)', () => {
    assert.match(omniboxInitScript('pwsh'), /GetNewClosure/);
  });

  test('pwsh: guards on CommandOrigin, NOT on call-stack depth', () => {
    const s = omniboxInitScript('pwsh');
    assert.match(s, /CommandOrigin/, 'the measured discriminator must be present');
    // Measured: depth is 2 for BOTH a Get-Command probe and a typed command, so a
    // depth guard lets everything through while looking like a filter.
    assert.doesNotMatch(s, /PSCallStack[\s\S]{0,40}-gt/,
      'call-stack depth was measured NOT to distinguish a probe from a real ' +
      'invocation — reintroducing it would send every script probe to the agent');
  });

  test('bash and zsh use their own hook name (one word apart, fails silently)', () => {
    assert.match(omniboxInitScript('bash'), /command_not_found_handle\(/);
    assert.match(omniboxInitScript('zsh'), /command_not_found_handler\(/);
    // ...and must not be swapped.
    assert.doesNotMatch(omniboxInitScript('bash'), /command_not_found_handler\(/);
  });

  test('every shell skips path-shaped names (a file mistake is not a question)', () => {
    // The two shell families spell the same guard completely differently, so this
    // asserts the guard per family rather than hunting one regex across both.
    // (The first version of this test tried a single combined pattern and failed
    // on a snippet that was correct -- the test was wrong, not the code.)
    for (const shell of ['pwsh', 'powershell'] as const) {
      const s = omniboxInitScript(shell);
      assert.match(s, /\$CommandName -match/,
        `${shell}: no path-shaped guard on $CommandName`);
      assert.match(s, /path-shaped name is a mistake about a FILE/,
        `${shell}: the guard lost the reason it exists`);
    }
    for (const shell of ['bash', 'zsh'] as const) {
      const s = omniboxInitScript(shell);
      assert.ok(s.includes('*/*'), `${shell}: no path-shaped case guard`);
    }
  });

  test('pwsh WARNS about a source tree on PSModulePath at install time', () => {
    // The claim this pins used to be false: the module docstring said `init`
    // refused to install over a pathological PSModulePath, while judgeOmnibox()
    // was reachable only from this very test file -- 23 green tests over a
    // feature production never ran. The warning below is the code path that
    // makes the claim true, and it must survive refactors.
    const s = omniboxInitScript('pwsh');
    assert.match(s, /PSModulePath/, 'no PSModulePath inspection at install time');
    assert.match(s, /Write-Warning/, 'detects the condition but tells nobody');
    // Structural, not timed -- measuring a miss would cost the 60s being warned
    // about, on every shell start.
    assert.match(s, /GetDirectories/, 'must count directories, not time a miss');
    assert.doesNotMatch(s, /Stopwatch/,
      'the install path must NOT time a command miss - that is the doctor subcommand job');
  });

  test('powershell and pwsh emit the same integration', () => {
    assert.equal(omniboxInitScript('powershell'), omniboxInitScript('pwsh'));
  });
});

describe('Windows Terminal install payload', () => {
  // This string is parsed TWICE -- as JSON, then split into argv by Windows --
  // and the first version passed JSON validation and still broke every new tab
  // with a ParserError, because the check was asserting the wrong layer.
  const suffix = terminalCommandlineSuffix();

  test('carries no double quote: JSON-valid escaping still arrives unquoted', () => {
    assert.ok(!suffix.includes(String.fromCharCode(34)),
      'a double quote here survives JSON and dies in the argv split');
  });

  test('carries no backslash: it would need JSON escaping and can be eaten', () => {
    assert.ok(!suffix.includes(String.fromCharCode(92)),
      'use forward slashes - PowerShell accepts them on Windows');
  });

  test('survives a JSON round trip byte-for-byte', () => {
    const line = 'pwsh -NoExit -Command [Console]::Write(1)' + suffix;
    assert.equal(JSON.parse(JSON.stringify({ commandline: line })).commandline, line);
  });

  test('installing keeps -NoExit, which is what makes the hook run at all', () => {
    const out = withTerminalOmnibox('pwsh -NoExit -Command [Console]::Write(1)');
    assert.match(out, /-NoExit/,
      'without -NoExit the omnibox loads and the guard then calls it automation');
  });

  test('is idempotent - a second install must not append twice', () => {
    const base = 'pwsh -NoExit -Command [Console]::Write(1)';
    const once = withTerminalOmnibox(base);
    assert.equal(withTerminalOmnibox(once), once);
  });
});
