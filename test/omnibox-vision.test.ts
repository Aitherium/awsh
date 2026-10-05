/**
 * Images reach the vision model from the terminal.
 *
 * Measured 2026-10-04: the gateway path (`_streamOpenAI`, used by the omnibox and
 * one-shot `ask`) sent the TEXT only, so `awsh ask --image shot.png "what is this"`
 * reached the model without the image; and an omnibox line naming an image file
 * sent the path as words. These pin the three pieces that close it.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { findImagePaths, wantsClipboardImage } from '../src/omnibox.js';
import { userContent, VISION_MODEL } from '../src/client.js';

describe('findImagePaths', () => {
  const exists = (p: string) => ['C:\\shots\\err.png', 'my shot.jpg', 'a.webp'].includes(p);

  test('finds an unquoted Windows path that exists', () => {
    assert.deepEqual(findImagePaths('what is in C:\\shots\\err.png ?', exists), ['C:\\shots\\err.png']);
  });
  test('finds a quoted path with spaces', () => {
    assert.deepEqual(findImagePaths('describe "my shot.jpg" please', exists), ['my shot.jpg']);
  });
  test('ignores an image name that does not exist (a word, not a file)', () => {
    assert.deepEqual(findImagePaths('how do I convert png to webp', exists), []);
    assert.deepEqual(findImagePaths('open missing.png', exists), []);
  });
  test('strips trailing punctuation and dedupes', () => {
    assert.deepEqual(findImagePaths('a.webp, a.webp.', exists), ['a.webp']);
  });
});

describe('wantsClipboardImage', () => {
  for (const l of ["what's in this screenshot", 'read my clipboard', 'what does the image i copied say']) {
    test(`clipboard: ${l}`, () => assert.equal(wantsClipboardImage(l), true));
  }
  for (const l of ['tell me a joke', 'how do screens work', 'should i drive to the car wash']) {
    test(`not clipboard: ${l}`, () => assert.equal(wantsClipboardImage(l), false));
  }
});

describe('userContent', () => {
  test('text only stays a plain string (every text turn unchanged)', () => {
    assert.equal(userContent('hi'), 'hi');
    assert.equal(userContent('hi', []), 'hi');
  });
  test('an image becomes an OpenAI image_url part after the text', () => {
    const c = userContent('what is this', ['data:image/png;base64,AAA']);
    assert.deepEqual(c, [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });
  test('image turns go to the vision route', () => {
    assert.equal(VISION_MODEL, 'aither-vision');
  });
});

describe('image turns are not streamed', () => {
  test('the client sends stream:false when an image is attached (stream:true 400s)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
    assert.match(src, /stream: !opts\.thinking && !opts\.attachments\?\.length/);
  });
});

describe('one system message', () => {
  test('the client joins the system blocks (two 502 a Gemma-template backend)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
    assert.match(src, /messages\.push\(\{ role: 'system', content: sys\.join\(/);
  });
});
