/**
 * Regression: answer reflow must fit the OUTPUT pane inner width so blessed's
 * own wrap:true never re-wraps a line into ragged 1-3 word orphan lines (the
 * "dogshit formatting" bug: ChatFormatter was hardcoded to 80 while the pane
 * was ~66 wide). Also: ANSI color codes must not count toward width.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  createChatFormatter,
  stripWrappingFence,
  stripFenceDelimiters,
} from '../src/tui/chat-formatter.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The exact reply shape reported from a live session. Both commands must reach
 * the pane on their OWN lines: this is the text a user copies, so a newline
 * turned into a space silently changes the command they run.
 */
const FENCED_REPLY = [
  'Useful ones for a remote box:',
  '```powershell',
  'Get-ComputerInfo | Select-Object CsName, WindowsVersion, OsArchitecture',
  'Get-NetIPConfiguration',
  '```',
].join('\n');

const PROSE =
  'Keep in mind that port 3389 is RDP (Remote Desktop Protocol), so connecting ' +
  'without authorization would be out of scope unless this is a controlled test ' +
  'environment, and you should verify connectivity before scanning the port.';

describe('ChatFormatter reflow', () => {
  test('no emitted line exceeds the configured pane width (visible cols)', () => {
    const width = 66;
    const fmt = createChatFormatter({ paneWidth: width });
    for (const line of fmt.formatAnswer(PROSE)) {
      assert.ok(
        stripAnsi(line).length <= width,
        `line "${line}" exceeds width ${width}`,
      );
    }
  });

  test('setPaneWidth is respected on resize', () => {
    const fmt = createChatFormatter({ paneWidth: 80 });
    fmt.setPaneWidth(40);
    for (const line of fmt.formatAnswer(PROSE)) {
      assert.ok(stripAnsi(line).length <= 40, `line "${line}" exceeds 40`);
    }
  });

  test('bold/code spans do not wrap early (ANSI not counted)', () => {
    // A single sentence with markdown that fits a 60-col pane visibly but blows
    // past 60 raw chars once chalk injects escape codes. Must stay one line.
    const fmt = createChatFormatter({ paneWidth: 60 });
    const lines = fmt.formatAnswer('Run **nmap** then `xfreerdp` to check RDP.')
      .filter(l => l.trim() !== '');
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}: ${JSON.stringify(lines)}`);
  });

  test('setPaneWidth ignores nonsense values', () => {
    const fmt = createChatFormatter({ paneWidth: 66 });
    fmt.setPaneWidth(NaN);
    fmt.setPaneWidth(0);
    // width unchanged → still fits 66
    for (const line of fmt.formatAnswer(PROSE)) {
      assert.ok(stripAnsi(line).length <= 66);
    }
  });
});

describe('ChatFormatter fences', () => {
  test('a fenced block keeps its own lines (never word-joined)', () => {
    const fmt = createChatFormatter({ paneWidth: 78 });
    const lines = fmt.formatAnswer(FENCED_REPLY).map(stripAnsi);

    const a = lines.findIndex(l => l.includes('Get-ComputerInfo'));
    const b = lines.findIndex(l => l.includes('Get-NetIPConfiguration'));
    assert.ok(a >= 0, `first command missing: ${JSON.stringify(lines)}`);
    assert.ok(b >= 0, `second command missing: ${JSON.stringify(lines)}`);
    // The regression printed both commands on ONE line, space-joined.
    assert.notEqual(a, b, `commands share a line (the run-on bug): ${JSON.stringify(lines)}`);

    const first = lines[a];
    assert.ok(
      first.includes('Select-Object CsName, WindowsVersion, OsArchitecture'),
      `first command was split/wrapped: ${JSON.stringify(first)}`,
    );
  });

  test('fence delimiters and the info string are never emitted', () => {
    const fmt = createChatFormatter({ paneWidth: 78 });
    const joined = fmt.formatAnswer(FENCED_REPLY).map(stripAnsi).join('\n');
    assert.ok(!joined.includes('```'), `delimiter leaked: ${JSON.stringify(joined)}`);
    assert.ok(
      !joined.includes('powershell'),
      `info string leaked as content: ${JSON.stringify(joined)}`,
    );
  });

  test('prose around a fence is still reflowed', () => {
    const fmt = createChatFormatter({ paneWidth: 78 });
    const lines = fmt.formatAnswer(FENCED_REPLY).map(stripAnsi);
    assert.ok(
      lines.some(l => l.includes('Useful ones for a remote box')),
      `prose dropped: ${JSON.stringify(lines)}`,
    );
  });
});

describe('stripWrappingFence', () => {
  test('a reply that is exactly one fence returns its inner text verbatim', () => {
    const inner = 'Get-ComputerInfo\nGet-NetIPConfiguration';
    assert.equal(stripWrappingFence('```powershell\n' + inner + '\n```'), inner);
  });

  test('surrounding blank lines do not defeat it', () => {
    const inner = 'ls -la';
    assert.equal(stripWrappingFence('\n\n```\n' + inner + '\n```\n\n'), inner);
  });

  test('an unlabeled fence is stripped too', () => {
    assert.equal(stripWrappingFence('```\nls\n```'), 'ls');
  });

  test('prose before a fence is left completely alone', () => {
    const mixed = 'Here you go:\n```\nls\n```';
    assert.equal(stripWrappingFence(mixed), mixed);
  });

  test('an unbalanced fence is left alone, never half-stripped', () => {
    const unbalanced = '```bash\nls';
    assert.equal(stripWrappingFence(unbalanced), unbalanced);
  });

  test('plain prose is a no-op', () => {
    assert.equal(stripWrappingFence(PROSE), PROSE);
  });
});

describe('stripFenceDelimiters', () => {
  test('strips a fence that is NOT alone in the text', () => {
    // The regression this exists for: job output carries trace lines above the
    // block, so `stripWrappingFence` fired on nothing and the delimiters still
    // printed. Caught by exercising the built dist, not by reading the code.
    const jobOutput = ['[trace] thinking', '---', '```powershell', 'ls -la', '```'].join('\n');
    const out = stripFenceDelimiters(jobOutput);
    assert.ok(!out.includes('```'), `delimiter survived: ${JSON.stringify(out)}`);
    assert.ok(out.includes('ls -la'), 'body was dropped');
    assert.ok(out.includes('[trace] thinking'), 'surrounding lines were dropped');
    assert.ok(!out.includes('powershell'), 'info string survived');
  });

  test('handles several blocks in one payload', () => {
    const text = '```\na\n```\nmiddle\n```bash\nb\n```';
    const out = stripFenceDelimiters(text);
    assert.ok(!out.includes('```'), `delimiter survived: ${JSON.stringify(out)}`);
    assert.ok(out.includes('a') && out.includes('middle') && out.includes('b'));
  });

  test('leaves text with no fence untouched', () => {
    assert.equal(stripFenceDelimiters(PROSE), PROSE);
  });
});
