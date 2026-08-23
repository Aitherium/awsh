/**
 * Context file loader — reads CLAUDE.md, AGENTS.md, AITHER.md and .claude/rules/*.md
 * from a workspace directory and extracts sections for the AI to use.
 *
 * Loaded contexts are attached to subsequent turns so the AI is aware of:
 *   - Project-specific rules and constraints (from CLAUDE.md)
 *   - Agent definitions (from AGENTS.md)
 *   - Domain knowledge (from AITHER.md)
 *   - Quality gates and procedures (from .claude/rules/*.md)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';

export interface ContextFileContent {
  /** File path relative to workspace root. */
  file: string;
  /** Raw file contents. */
  content: string;
  /** Parsed sections extracted from markdown. */
  sections: Array<{
    level: number;  // 1-3 for #/##/###
    name: string;   // Section heading text
    content: string; // Content under this heading until next section
  }>;
}

export interface LoadedContexts {
  /** All loaded file contents. */
  files: ContextFileContent[];
  /** Concatenated contents of all files for AI context (ready to prepend to system prompt). */
  fullContent: string;
  /** Brief summary of what was loaded (for user feedback). */
  summary: string;
}

/**
 * Parse markdown sections from a file's content.
 * Returns array of { level, name, content } for each ## and ### heading.
 */
function extractSections(
  content: string,
): Array<{ level: number; name: string; content: string }> {
  const sections: Array<{ level: number; name: string; content: string }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hashMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hashMatch) {
      const level = hashMatch[1].length;
      const name = hashMatch[2].trim();

      // Find content until next heading
      let contentLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        // Stop at next heading of same or higher level
        if (nextLine.match(/^#{1,3}\s+/)) {
          const nextLevel = nextLine.match(/^(#{1,3})/)?.[1].length || 0;
          if (nextLevel <= level) break;
        }
        contentLines.push(nextLine);
      }

      sections.push({
        level,
        name,
        content: contentLines.join('\n').trim(),
      });
    }
  }

  return sections;
}

/**
 * Load context files from a workspace directory.
 * Searches for CLAUDE.md, AGENTS.md, AITHER.md at the root, and .claude/rules/*.md.
 * Returns the combined content suitable for injecting into a system prompt.
 */
export function loadContextFiles(workspacePath: string): LoadedContexts {
  const files: ContextFileContent[] = [];
  let fileCount = 0;
  let sectionCount = 0;

  // Normalize path
  const wsPath = resolve(workspacePath);

  if (!existsSync(wsPath)) {
    return {
      files: [],
      fullContent: '',
      summary: chalk.dim('(workspace path does not exist)'),
    };
  }

  // Root-level context files
  const rootFiles = ['CLAUDE.md', 'AGENTS.md', 'AITHER.md'];
  for (const fname of rootFiles) {
    const fpath = join(wsPath, fname);
    if (existsSync(fpath)) {
      try {
        const content = readFileSync(fpath, 'utf-8');
        const sections = extractSections(content);
        files.push({
          file: fname,
          content,
          sections,
        });
        fileCount++;
        sectionCount += sections.length;
      } catch (err) {
        console.log(
          chalk.yellow(`  ⚠ Failed to read ${fname}:`),
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // .claude/rules/*.md files
  const rulesDir = join(wsPath, '.claude', 'rules');
  if (existsSync(rulesDir)) {
    try {
      const rulesFiles = readdirSync(rulesDir).filter((f) =>
        f.endsWith('.md'),
      );
      for (const fname of rulesFiles.sort()) {
        const fpath = join(rulesDir, fname);
        try {
          const content = readFileSync(fpath, 'utf-8');
          const sections = extractSections(content);
          files.push({
            file: `.claude/rules/${fname}`,
            content,
            sections,
          });
          fileCount++;
          sectionCount += sections.length;
        } catch (err) {
          console.log(
            chalk.yellow(`  ⚠ Failed to read .claude/rules/${fname}:`),
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } catch {
      // .claude/rules does not exist — that's ok
    }
  }

  // Build full content for AI context
  const fullContent = files
    .map(
      (f) =>
        `\n## Context: ${f.file}\n\n${'='.repeat(60)}\n\n${f.content}`,
    )
    .join('\n\n');

  const summary = fileCount === 0
    ? chalk.dim('(no context files found)')
    : chalk.green(
        `Loaded ${fileCount} file${fileCount > 1 ? 's' : ''} (${sectionCount} sections)`,
      );

  return {
    files,
    fullContent,
    summary,
  };
}
