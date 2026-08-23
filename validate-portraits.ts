/**
 * Validate that generated portraits can be rendered by the TUI.
 * Tests the renderPortrait function with generated images.
 */
import { renderPortrait } from './src/tui/portrait';

const PORTRAIT_DIR = './assets/aither-portrait';

function validatePortrait(emotion: string): boolean {
  console.log(`\nValidating [${emotion}]...`);

  const rendered = renderPortrait(PORTRAIT_DIR, emotion, { cols: 40 });

  if (!rendered) {
    console.log(`  ERROR: renderPortrait returned null`);
    return false;
  }

  if (!Array.isArray(rendered)) {
    console.log(`  ERROR: renderPortrait did not return array`);
    return false;
  }

  if (rendered.length === 0) {
    console.log(`  ERROR: renderPortrait returned empty array`);
    return false;
  }

  console.log(`  Lines: ${rendered.length}`);

  // Check for truecolor codes (38;2 for fg, 48;2 for bg)
  const combined = rendered.join('');
  const hasHalfBlock = combined.includes('▀') || combined.includes('▄');
  const hasTruecolor = combined.includes('38;2') || combined.includes('48;2');

  console.log(`  Half-block chars: ${hasHalfBlock ? 'YES' : 'NO'}`);
  console.log(`  Truecolor codes (38;2/48;2): ${hasTruecolor ? 'YES' : 'NO'}`);

  // Show first few lines (with escape codes visible)
  console.log(`  First 3 lines (truncated):`);
  for (let i = 0; i < Math.min(3, rendered.length); i++) {
    const line = rendered[i];
    // Show up to 120 chars, making escape codes visible
    const visible = line
      .slice(0, 120)
      .replace(/\x1b/g, '\\x1b')
      .replace(/\[/g, '[');
    console.log(`    ${visible}...`);
  }

  return hasHalfBlock && hasTruecolor;
}

async function main() {
  console.log('Portrait Validation');
  console.log('==================');
  console.log(`Portrait dir: ${PORTRAIT_DIR}`);

  const emotions = ['neutral', 'happy', 'angry', 'thinking'];
  const results: Record<string, boolean> = {};

  for (const emotion of emotions) {
    results[emotion] = validatePortrait(emotion);
  }

  console.log('\n' + '='.repeat(40));
  console.log('SUMMARY:');
  for (const [emotion, success] of Object.entries(results)) {
    const status = success ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${emotion}`);
  }

  const allPass = Object.values(results).every(v => v);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});
