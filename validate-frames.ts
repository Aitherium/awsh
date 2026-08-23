/**
 * Validate animated portrait frames for TUI rendering.
 * Tests each frame in the idle sequence for:
 * - PNG decoding success
 * - Truecolor ANSI code generation (38;2; half-blocks)
 * - Row fit at various column widths (target: ~40-48 rows at cols=40)
 */

import { renderPngFile } from './src/tui/portrait';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const idleDir = join(__dirname, 'assets', 'aither-portrait', 'idle');

console.log(`Validating frames in ${idleDir}\n`);

if (!existsSync(idleDir)) {
  console.error(`ERROR: idle directory not found at ${idleDir}`);
  process.exit(1);
}

// Collect all frame_*.png files
const frames = readdirSync(idleDir)
  .filter(f => /^frame_\d+\.png$/.test(f))
  .sort();

if (frames.length === 0) {
  console.error(`ERROR: No frame_*.png files found in ${idleDir}`);
  process.exit(1);
}

console.log(`Found ${frames.length} frames: ${frames.join(', ')}\n`);

let allPass = true;
const samples: { cols: number, frame: number, rows: number }[] = [];

frames.forEach((frame, idx) => {
  const path = join(idleDir, frame);
  console.log(`[${idx + 1}/${frames.length}] ${frame}`);

  // Test at multiple column widths
  const testCols = [40, 48, 64];
  const results: { cols: number, rows: number, hasTruecolor: boolean }[] = [];

  testCols.forEach(cols => {
    const lines = renderPngFile(path, cols);

    if (!lines) {
      console.error(`  ✗ cols=${cols}: Failed to decode/render PNG`);
      allPass = false;
      return;
    }

    const rows = lines.length;

    // Check for truecolor ANSI codes (38;2; or 48;2;)
    const ansiText = lines.join('');
    const hasTruecolor = /\x1b\[(?:38|48);2;\d+;\d+;\d+m/.test(ansiText);

    const status = hasTruecolor ? '✓' : '✗';
    console.log(`  ${status} cols=${cols}: ${rows} rows${hasTruecolor ? ' (truecolor)' : ' (NO TRUECOLOR)'}`);

    if (!hasTruecolor) {
      allPass = false;
      console.warn(`    WARNING: No truecolor ANSI codes detected at cols=${cols}`);
    }

    if (cols === 40) {
      if (rows < 40 || rows > 48) {
        console.warn(`    WARNING: Row count ${rows} outside target range 40-48`);
        allPass = false;
      } else {
        console.log(`    ✓ Within target range 40-48 rows`);
      }
    }

    results.push({ cols, rows, hasTruecolor });
    if (cols === 40 && idx === 0) {
      samples.push({ cols, frame: idx, rows });
    }
  });

  console.log('');
});

console.log('='.repeat(60));
console.log(`Overall: ${allPass ? '✓ PASS' : '✗ FAIL'}`);
console.log(`Total frames validated: ${frames.length}`);

if (samples.length > 0) {
  console.log('\nFrame dimensions at key column widths:');
  console.log(`  Frame ${samples[0].frame}: ${samples[0].rows} rows at cols=${samples[0].cols}`);
}

process.exit(allPass ? 0 : 1);
