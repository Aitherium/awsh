/**
 * A cited source must be clickable, and the URL must never be lost.
 *
 * Reported 2026-08-23: "still weak as hell and doesn't even give clickable
 * links". Two distinct failures behind one complaint, and a fix for either one
 * alone leaves the other:
 *
 *   1. the model emits `[CNN](https://www.cnn.com/)` despite being told plain
 *      terminal text -- measured on roughly half of runs -- so the reader sees
 *      markdown punctuation in a terminal that will not render it;
 *   2. on the other runs it names outlets with NO url at all, which is a
 *      citation nobody can follow.
 *
 * (2) is a prompt matter. (1) is this: the answer is rewritten so markdown
 * links become OSC 8 hyperlinks on their label, and any bare URL becomes one on
 * itself. A terminal without OSC 8 drops the escape and still shows the label,
 * which is why the markdown is REWRITTEN rather than merely detected -- the
 * fallback has to stay readable, and `[CNN](url)` is not.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { linkifyTerminal, parseSearchHits, renderSources } from '../src/renderer.js';

const OSC = '\x1b]8;;';

/** How many OSC 8 sequences were opened. */
function linkCount(s: string): number {
  return s.split(OSC).length - 1;
}

describe('omnibox answers are linkified for the terminal', () => {
  test('a markdown link becomes a hyperlink and the punctuation is gone', () => {
    const out = linkifyTerminal('See [CNN](https://www.cnn.com/) for more.');
    assert.ok(out.includes(`${OSC}https://www.cnn.com/`), 'no OSC 8 target emitted');
    assert.ok(out.includes('CNN'), 'the label was dropped');
    assert.ok(!out.includes(']('), 'markdown punctuation survived into terminal output');
    assert.equal(linkCount(out), 2, 'expected exactly one open + one close');
  });

  test('a bare URL becomes a hyperlink', () => {
    const out = linkifyTerminal('Source: https://example.com/a/b');
    assert.ok(out.includes(`${OSC}https://example.com/a/b`), 'bare URL was not linked');
  });

  test('trailing sentence punctuation stays OUT of the link target', () => {
    // A URL swallowing the full stop yields a 404 on click, which is worse than
    // no link: it looks like the source is gone rather than like a bad parse.
    const out = linkifyTerminal('Read https://example.com/story.');
    assert.ok(out.includes(`${OSC}https://example.com/story\x1b`),
      'the trailing period was captured into the URL');
    assert.ok(out.endsWith('.'), 'the sentence lost its full stop');
  });

  test('a markdown link whose LABEL is a URL is not nested', () => {
    // The two-pass version of this function re-read its own output and wrapped
    // an escape sequence inside another, which prints as raw bytes. One
    // non-overlapping pass cannot, and this is the case that proves it.
    const out = linkifyTerminal('[https://a.example](https://b.example)');
    assert.equal(linkCount(out), 2, 'the link was nested inside another');
    assert.ok(out.includes(`${OSC}https://b.example`), 'the wrong URL became the target');
  });

  test('text with no links is returned untouched', () => {
    // This runs over EVERY omnibox answer, including the shell one-liners the
    // feature exists to print. A transform that guesses at structure would
    // mangle them.
    const plain = 'Get-ChildItem -Recurse | Select-Object -First 5';
    assert.equal(linkifyTerminal(plain), plain);
    assert.equal(linkifyTerminal(''), '');
  });
});

describe('search sources are recovered from the TOOL output', () => {
  test('the JSON shape (dr_web_search)', () => {
    const hits = parseSearchHits(JSON.stringify({
      query: 'news',
      results: [
        { title: 'Trade war escalates', url: 'https://ex.com/a', snippet: 'Tariffs...' },
        { title: 'Second story', link: 'https://ex.com/b', description: 'More...' },
      ],
    }));
    assert.equal(hits.length, 2, 'the JSON shape was not understood');
    assert.equal(hits[0].url, 'https://ex.com/a');
    assert.equal(hits[1].url, 'https://ex.com/b', 'the `link` spelling was not accepted');
    assert.equal(hits[1].snippet, 'More...');
  });

  test('the TEXT shape (web_search / awfind triples)', () => {
    // Both shapes are live: the model picks either tool per turn, and a parser
    // written for one returns [] for the other -- which prints no sources and
    // is indistinguishable from a search that found nothing.
    const hits = parseSearchHits(
      'Newcastle vs Liverpool\nhttps://sports.example/a\nBoth teams changed managers.\n\n' +
      'Dodgers Roundup\nhttps://sports.example/b\nLA called up an outfielder.');
    assert.equal(hits.length, 2, 'the text shape was not understood');
    assert.equal(hits[0].title, 'Newcastle vs Liverpool');
    assert.equal(hits[1].snippet, 'LA called up an outfielder.');
  });

  test('a bare URL with no title is not offered as a source', () => {
    assert.deepEqual(parseSearchHits('https://ex.com/x'), []);
    assert.deepEqual(parseSearchHits(''), []);
    assert.deepEqual(parseSearchHits('no links here at all'), []);
  });

  test('rendered sources are clickable and carry the title as the label', () => {
    const block = renderSources(parseSearchHits(
      JSON.stringify({ results: [{ title: 'Story', url: 'https://ex.com/s', snippet: 'x' }] })));
    assert.ok(block.includes('\x1b]8;;https://ex.com/s'), 'the source is not a hyperlink');
    assert.ok(block.includes('Story'), 'the title is not the visible label');
    assert.equal(renderSources([]), '', 'an empty result set must print nothing at all');
  });
});

describe('truncated tool output still yields sources', () => {
  test('a JSON array cut mid-object salvages the complete pairs', () => {
    // Not an edge case: the daemon caps tool output (measured at 500 chars),
    // which cuts the array mid-object. A strict parser then reports NO SOURCES
    // for a search that worked perfectly -- identical, to the reader, to a
    // search that found nothing.
    const truncated =
      '{"query": "news today", "results": [' +
      '{"title": "Breaking News | CNN", "url": "https://www.cnn.com/", "snippet": "Latest"}, ' +
      '{"title": "AP News", "url": "https://apnews.com/", "snippet": "World"}, ' +
      '{"title": "NBC News", "url": "https://www.nbcnew';   // <- cut here
    assert.throws(() => JSON.parse(truncated), 'the fixture must actually be invalid JSON');
    const hits = parseSearchHits(truncated);
    assert.equal(hits.length, 2, 'the surviving complete pairs were not salvaged');
    assert.equal(hits[0].url, 'https://www.cnn.com/');
    assert.equal(hits[1].title, 'AP News');
  });

  test('salvage does not fire on prose that merely mentions a url', () => {
    // The salvage runs only when the output looks like a "url": field. Prose
    // must fall through to the line scan, or a chatty answer would be mined for
    // fake sources.
    assert.deepEqual(parseSearchHits('the url is important when citing'), []);
  });
});
