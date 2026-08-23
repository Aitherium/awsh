/**
 * Tool result expand overlay: click a tool sub-node row or press 'e' with
 * trace focused to open a centered blessed overlay showing pretty-printed
 * JSON args and result (capped 5KB each), scrollable, Esc/q to close.
 */
import { createRequire } from 'node:module';
import chalk from 'chalk';
import type { ToolDetail } from './event-schema.js';

const nodeRequire = createRequire(import.meta.url);
const blessed: any = nodeRequire('neo-blessed');

export interface ToolResultViewerOpts {
  screen: any;  // blessed screen instance
}

/**
 * Show a tool result in a centered overlay.
 * Resolves when the user closes it (Esc/q).
 */
export async function showToolResultViewer(
  screen: any,
  tool: ToolDetail,
): Promise<void> {
  return new Promise((resolve) => {
    // Center the box: 80% width/height
    const boxWidth = Math.floor(screen.width * 0.8);
    const boxHeight = Math.floor(screen.height * 0.8);
    const boxTop = Math.floor((screen.height - boxHeight) / 2);
    const boxLeft = Math.floor((screen.width - boxWidth) / 2);

    const box = blessed.box({
      parent: screen,
      top: boxTop,
      left: boxLeft,
      width: boxWidth,
      height: boxHeight,
      border: 'line',
      label: ` ${tool.name} `,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        label: { fg: 'cyan', bold: true },
      },
      tags: false,
      wrap: true,
    });

    // Build content: args + result
    const content: string[] = [];

    if (Object.keys(tool.args).length > 0) {
      content.push(chalk.bold('Arguments:'));
      const argsJson = JSON.stringify(tool.args, null, 2);
      const argsCapped = argsJson.length > 5120
        ? argsJson.slice(0, 5120) + `\n… (${argsJson.length} bytes total — capped)`
        : argsJson;
      content.push(argsCapped);
    }

    if (tool.result) {
      content.push('');
      content.push(chalk.bold('Result:'));
      let resultJson = '';
      if (typeof tool.result === 'string') {
        resultJson = tool.result.length > 5120
          ? tool.result.slice(0, 5120) + `\n… (${tool.result.length} bytes total — capped)`
          : tool.result;
      } else {
        resultJson = JSON.stringify(tool.result, null, 2);
        resultJson = resultJson.length > 5120
          ? resultJson.slice(0, 5120) + `\n… (${JSON.stringify(tool.result).length} bytes total — capped)`
          : resultJson;
      }
      content.push(resultJson);
    }

    if (tool.ms) {
      content.push('');
      content.push(chalk.dim(`Duration: ${tool.ms}ms`));
    }

    box.setContent(content.join('\n'));

    // Close on Esc or q
    box.key(['escape', 'q'], () => {
      box.destroy();
      resolve();
    });

    screen.render();
  });
}
