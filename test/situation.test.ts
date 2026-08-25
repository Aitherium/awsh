/**
 * Tests for situation.ts — the live-state block every turn carries.
 *
 * The bug this guards (found 2026-08-23): asked "what time is it" at the
 * omnibox, the agent took 19.6 s and illustrated its answer with
 * "Tuesday, June 4, 2025" — a date it invented, because no request carried a
 * clock. Every assertion below fails against a shell that sends the line bare.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SITUATION_HEADER,
  answerFromSituation,
  buildSituation,
  formatLocalTime,
  readGitBranch,
  renderSituation,
  selfTest,
  situationEnabled,
  sniffShellName,
  stripOmniboxOpener,
} from '../src/situation.js';

describe('situation self-test', () => {
  test('every pinned property holds', () => {
    const failures = selfTest();
    assert.deepEqual(failures, [], failures.join('\n'));
  });
});

describe('renderSituation', () => {
  const fixed = new Date(2026, 7, 23, 6, 11, 5); // Sunday 06:11:05 local
  const inputs = {
    now: fixed, cwd: 'C:\\Users\\wzns', shellName: 'PowerShell 7 (pwsh)', env: { WT_SESSION: 'x' },
    platform: 'win32', release: '10.0.26200', hostname: 'BOX', username: 'wzns', gitBranch: 'feat/x',
  };

  test('carries the clock as a weekday + date + time, and the UTC instant', () => {
    const out = renderSituation(inputs);
    assert.ok(out.startsWith(SITUATION_HEADER));
    assert.match(out, /local time: Sunday 2026-08-23 06:11:05 \(UTC[+-]\d\d:\d\d/);
    assert.ok(out.includes(`utc: ${fixed.toISOString()}`));
  });

  test('names shell, os, host, user, cwd, branch, terminal', () => {
    const out = renderSituation(inputs);
    for (const line of [
      'shell: PowerShell 7 (pwsh)', 'os: Windows 10.0.26200', 'host: BOX',
      'user: wzns', 'cwd: C:\\Users\\wzns', 'git branch: feat/x', 'terminal: Windows Terminal',
    ]) assert.ok(out.includes(line), `missing "${line}" in:\n${out}`);
  });

  test('tells the model to answer from the block, not a tool, and not a guess', () => {
    const out = renderSituation(inputs);
    assert.match(out, /do NOT call a tool/);
    assert.match(out, /do NOT guess or invent a date/);
  });

  test('omits what it cannot determine rather than stating it', () => {
    const out = renderSituation({ ...inputs, shellName: 'unknown (do not assume bash)', hostname: '', username: '', gitBranch: undefined, env: {} });
    assert.doesNotMatch(out, /^shell:/m);
    assert.doesNotMatch(out, /^host:/m);
    assert.doesNotMatch(out, /^user:/m);
    assert.doesNotMatch(out, /git branch/);
    assert.doesNotMatch(out, /^terminal:/m);
  });

  test('stays small — it rides on every turn', () => {
    assert.ok(renderSituation(inputs).length < 900);
  });
});

describe('formatLocalTime', () => {
  test('zero-pads and names the weekday', () => {
    const d = new Date(2026, 0, 5, 9, 3, 7); // Monday
    assert.match(formatLocalTime(d), /^Monday 2026-01-05 09:03:07 \(UTC[+-]\d\d:\d\d\)$/);
    assert.match(formatLocalTime(d, 'America/Los_Angeles'), /, America\/Los_Angeles\)$/);
  });
});

describe('readGitBranch — one file read, no subprocess', () => {
  test('finds the branch from a nested cwd, names detached HEAD, handles no repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'awsh-sit-'));
    try {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/tunnel\n');
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      assert.equal(readGitBranch(join(root, 'a', 'b')), 'feat/tunnel');
      writeFileSync(join(root, '.git', 'HEAD'), 'abcdef0123456789\n');
      assert.equal(readGitBranch(root), 'detached@abcdef0123');
      // Depth cap: a repo further up than maxLevels is NOT found (bounded cost).
      assert.equal(readGitBranch(join(root, 'a', 'b'), 1), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sniffShellName', () => {
  test('env-first, then PowerShell tells, then $SHELL, else undefined', () => {
    assert.equal(sniffShellName({ AITHER_OMNIBOX_SHELL: 'pwsh' }), 'PowerShell 7 (pwsh)');
    assert.equal(sniffShellName({ AITHER_OMNIBOX_SHELL: 'powershell' }), 'Windows PowerShell 5.1');
    assert.equal(sniffShellName({ AITHER_OMNIBOX_SHELL: 'awsh' }), 'awsh (the AitherOS shell)');
    assert.equal(sniffShellName({ POWERSHELL_DISTRIBUTION_CHANNEL: 'MSI' }), 'PowerShell 7 (pwsh)');
    assert.equal(sniffShellName({ PSModulePath: 'x' }), 'Windows PowerShell');
    assert.equal(sniffShellName({ SHELL: '/bin/zsh' }), 'zsh');
    assert.equal(sniffShellName({}), undefined);
  });
});

describe('kill switch', () => {
  test('AWSH_SITUATION=0 disables; default on; buildSituation honours it', () => {
    assert.equal(situationEnabled({ AWSH_SITUATION: '0' }), false);
    assert.equal(situationEnabled({}), true);
    assert.equal(buildSituation('pwsh', { AWSH_SITUATION: '0' }), undefined);
    const live = buildSituation('pwsh', {});
    assert.ok(live && live.startsWith(SITUATION_HEADER));
    assert.ok(live!.includes(`cwd: ${process.cwd()}`));
  });
});

describe('answerFromSituation — the shell answers state questions itself', () => {
  const s = {
    now: new Date(2026, 7, 23, 6, 49, 12), cwd: 'C:\\Users\\wzns', shellName: 'pwsh', env: {},
    platform: 'win32', release: '10.0', hostname: 'BOX', username: 'wzns', gitBranch: undefined,
  };
  test('the exact line the owner typed, and its variants, yield the clock', () => {
    for (const q of ['WHAT TIME IS IT', 'what time is it?', 'what is the time', 'what day is it',
                     'time now', "what's the date", 'what year is it', 'current time']) {
      const a = answerFromSituation(q, s);
      assert.ok(a && /^Sunday 2026-08-23 06:49:12 \(UTC/.test(a.value), `${q} -> ${a?.value}`);
      assert.equal(a!.command, 'Get-Date');
    }
  });
  test('cwd, whoami, hostname', () => {
    assert.deepEqual(answerFromSituation('where am i', s), { value: 'C:\\Users\\wzns', command: 'Get-Location' });
    assert.deepEqual(answerFromSituation('pwd', s), { value: 'C:\\Users\\wzns', command: 'Get-Location' });
    assert.deepEqual(answerFromSituation('whoami', s), { value: 'wzns', command: '$env:USERNAME' });
    assert.deepEqual(answerFromSituation('what is the hostname', s), { value: 'BOX', command: 'hostname' });
    // The command follows the SHELL, not the internet's default.
    assert.equal(answerFromSituation('pwd', { ...s, shellName: 'zsh' })!.command, 'pwd');
    assert.equal(answerFromSituation('what time is it', { ...s, shellName: 'bash' })!.command, 'date');
  });
  test('anything else goes to the agent untouched (no false positives)', () => {
    for (const q of ['what time does the store open', 'time travel movies', 'vaporwave aesthetic music',
                     'laude', 'how do I set the time zone', 'date -u +%s', 'what is the time complexity of sort']) {
      assert.equal(answerFromSituation(q, s), undefined, q);
    }
  });
  test('an unknown user/host is undefined, never an empty fact', () => {
    assert.equal(answerFromSituation('whoami', { ...s, username: '' }), undefined);
  });
});

describe('stripOmniboxOpener — the opener the 4B model will not stop writing', () => {
  test('removes the leading not-a-command sentence, keeps the answer', () => {
    assert.equal(stripOmniboxOpener('This was a question, not a command. I know because I read the clock.'),
      'I know because I read the clock.');
    assert.equal(stripOmniboxOpener('That is a question, not a command. Hello.'), 'Hello.');
    assert.equal(stripOmniboxOpener('This line is not a command; it is a question. I know because you told me.'),
      'I know because you told me.');
    assert.equal(stripOmniboxOpener('The line "clauder" is not a recognized PowerShell command. Did you mean claude?'),
      'Did you mean claude?');
    assert.equal(stripOmniboxOpener('The command "clauder" is not recognized in PowerShell. It may be a typo.'),
      'It may be a typo.');
  });
  test('never deletes a whole answer, never touches a normal one', () => {
    assert.equal(stripOmniboxOpener('This is not a command.'), 'This is not a command.');
    assert.equal(stripOmniboxOpener('The time in Tokyo is 23:33.'), 'The time in Tokyo is 23:33.');
    assert.equal(stripOmniboxOpener(''), '');
  });
});
