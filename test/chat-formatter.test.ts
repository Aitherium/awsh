/**
 * Regression: answer reflow must fit the OUTPUT pane inner width so blessed's
 * own wrap:true never re-wraps a line into ragged 1-3 word orphan lines (the
 * "dogshit formatting" bug: ChatFormatter was hardcoded to 80 while the pane
 * was ~66 wide). Also: ANSI color codes must not count toward width.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { createChatFormatter } from '../src/tui/chat-formatter.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
