/**
 * doc-view.ts — Load a file and render it into lines for the in-TUI document
 * viewer (`/view <path>`): markdown gets the full terminal-markdown render,
 * code/text get a line-numbered gutter, and images render inline as half-blocks
 * (see image-preview.ts). The pure load/render logic lives here so it's testable
 * and so both the viewer overlay and a future `/edit` share one classifier.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import chalk from 'chalk';
import { renderMarkdown, stripOsc8, resolveImagePath } from './renderer.js';
import { imageToAnsi, imageDimensions } from './image-preview.js';

export type DocKind = 'markdown' | 'code' | 'text' | 'image' | 'binary' | 'missing';

export interface LoadedDoc {
  kind: DocKind;
  absPath: string;
  title: string;
  ext: string;
  sizeBytes: number;
  /** Raw text content (text/code/markdown only). */
  text?: string;
  /** Error/explanatory note for the header line. */
  note?: string;
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXTS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.psm1',
  '.sql', '.css', '.scss', '.html', '.xml', '.toml', '.ini', '.dockerfile',
]);
const DATA_EXTS = new Set(['.json', '.yaml', '.yml', '.csv', '.log', '.txt', '.env', '.conf', '.cfg']);

/** Map a file extension to a markdown fence language for syntax highlighting. */
function fenceLang(ext: string): string {
  const e = ext.replace(/^\./, '');
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', ps1: 'powershell', psm1: 'powershell',
    yml: 'yaml', sh: 'bash',
  };
  return map[e] || e || '';
}

/** Resolve a user-supplied path against cwd + the known AitherOS roots. */
export function resolveDocPath(input: string): string {
  const raw = input.replace(/^["']|["']$/g, '').trim();
  if (isAbsolute(raw) && existsSync(raw)) return raw;
  const cwdTry = resolve(process.cwd(), raw);
  if (existsSync(cwdTry)) return cwdTry;
  // Reuse the renderer's AitherOS-root resolver (handles Library/ paths etc.).
  try {
    const r = resolveImagePath(raw);
    if (existsSync(r)) return r;
  } catch { /* */ }
  return cwdTry; // best-effort; caller checks existsSync via kind === 'missing'
}

/** Load + classify a file. Never throws. */
export function loadDoc(input: string): LoadedDoc {
  const absPath = resolveDocPath(input);
  const ext = extname(absPath).toLowerCase();
  const title = basename(absPath);
  if (!existsSync(absPath)) {
    return { kind: 'missing', absPath, title, ext, sizeBytes: 0, note: 'file not found' };
  }
  let sizeBytes = 0;
  try {
    const st = statSync(absPath);
    sizeBytes = st.size;
    if (st.isDirectory()) {
      return { kind: 'missing', absPath, title, ext, sizeBytes: 0, note: 'is a directory (pass a file)' };
    }
  } catch { /* */ }

  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image', absPath, title, ext, sizeBytes };
  }

  // Read as text (cap at 2 MB so a huge log doesn't stall the render).
  const CAP = 2 * 1024 * 1024;
  let text: string;
  try {
    const buf = readFileSync(absPath);
    if (buf.includes(0)) {
      return { kind: 'binary', absPath, title, ext, sizeBytes, note: 'binary file' };
    }
    text = buf.length > CAP
      ? buf.subarray(0, CAP).toString('utf-8') + '\n…(truncated)…'
      : buf.toString('utf-8');
  } catch (e: any) {
    return { kind: 'binary', absPath, title, ext, sizeBytes, note: e?.message || 'unreadable' };
  }

  if (MARKDOWN_EXTS.has(ext)) return { kind: 'markdown', absPath, title, ext, sizeBytes, text };
  if (CODE_EXTS.has(ext) || DATA_EXTS.has(ext)) return { kind: 'code', absPath, title, ext, sizeBytes, text };
  return { kind: 'text', absPath, title, ext, sizeBytes, text };
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ViewRender {
  lines: string[];
  /** When the doc is an image the viewer couldn't render inline (non-PNG), the
   *  caller should OS-open this path instead. */
  fallbackOpenPath?: string;
}

/**
 * Render a loaded doc into display lines for the viewer overlay, wrapped to
 * `width` columns. Markdown → terminal markdown; code/text → line-numbered;
 * image → inline half-blocks (PNG) or a note + OS-open fallback.
 */
export function renderDocLines(doc: LoadedDoc, width: number): ViewRender {
  const innerW = Math.max(20, width - 2);

  if (doc.kind === 'missing' || doc.kind === 'binary') {
    return { lines: [chalk.red(`  ${doc.note || doc.kind}`), chalk.dim(`  ${doc.absPath}`)] };
  }

  if (doc.kind === 'image') {
    const dims = imageDimensions(doc.absPath);
    const header = [
      chalk.dim(`  ${humanSize(doc.sizeBytes)}${dims ? ` · ${dims.width}×${dims.height}` : ''}`),
      '',
    ];
    const ansi = imageToAnsi(doc.absPath, Math.min(innerW, 100), 44);
    if (ansi) return { lines: [...header, ...ansi.map(l => ' ' + l)] };
    // Non-PNG (JPEG/WEBP/…): can't decode without a dep — OS-open instead.
    return {
      lines: [
        ...header,
        chalk.yellow(`  ${doc.ext.replace('.', '').toUpperCase()} preview not supported inline — opening in your OS viewer.`),
        chalk.dim('  (PNG renders inline; other formats open externally.)'),
      ],
      fallbackOpenPath: doc.absPath,
    };
  }

  if (doc.kind === 'markdown' && doc.text != null) {
    const rendered = stripOsc8(renderMarkdown(doc.text));
    return { lines: rendered.replace(/\n$/, '').split('\n') };
  }

  // code / text → line-numbered gutter.
  const text = doc.text ?? '';
  const rawLines = text.split('\n');
  const gutterW = String(rawLines.length).length;
  const lang = doc.kind === 'code' ? fenceLang(doc.ext) : '';
  const out: string[] = [];
  rawLines.forEach((ln, i) => {
    const num = chalk.dim(String(i + 1).padStart(gutterW, ' ') + ' │ ');
    // Light, dependency-free emphasis for code: comments dimmed.
    let body = ln;
    if (lang && /^\s*(#|\/\/|--|;)/.test(ln)) body = chalk.dim(ln);
    out.push(num + body);
  });
  return { lines: out };
}
