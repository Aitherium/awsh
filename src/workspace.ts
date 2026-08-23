/**
 * Workspace management — project registry, switching, and context loading.
 *
 * Stores registered projects in ~/.aither/projects.json and the active project
 * in ~/.aither/shell.yaml (activeProject, projectPath).
 *
 * On project switch, loads context files and updates env vars for downstream
 * Genesis calls to pick up the project scope.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import chalk from 'chalk';
import type { ShellConfig } from './config.js';
import { loadContextFiles, type LoadedContexts } from './context-loader.js';

/** Persistent project registry stored in ~/.aither/projects.json. */
export interface ProjectRegistry {
  projects: Array<{
    name: string;
    path: string;
    lastAccessed?: number;
  }>;
}

/** In-memory active workspace state. */
export interface ActiveWorkspace {
  project?: string; // Project name
  path?: string;    // Absolute project path
  context?: LoadedContexts; // Loaded context files
}

let _activeWorkspace: ActiveWorkspace = {};

/**
 * Get the projects registry file path.
 */
function getProjectsFile(): string {
  const configDir = join(homedir(), '.aither');
  return join(configDir, 'projects.json');
}

/**
 * Load the projects registry (creates empty if missing).
 */
function loadProjectRegistry(): ProjectRegistry {
  const projectsFile = getProjectsFile();
  try {
    if (existsSync(projectsFile)) {
      const content = readFileSync(projectsFile, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.log(chalk.yellow('  Warning: failed to load projects registry'));
  }
  return { projects: [] };
}

/**
 * Save the projects registry.
 */
function saveProjectRegistry(registry: ProjectRegistry): void {
  const projectsFile = getProjectsFile();
  const configDir = join(homedir(), '.aither');
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(projectsFile, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.log(chalk.yellow('  Failed to save projects registry:'), err instanceof Error ? err.message : String(err));
  }
}

/**
 * Save a key-value pair to ~/.aither/shell.yaml (matches repl.ts implementation).
 */
export function saveConfigKey(key: string, value: string): void {
  const configDir = join(homedir(), '.aither');
  const configFile = join(configDir, 'shell.yaml');
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    let content = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : '';
    const lines = content.split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\w+):\s*/);
      if (match && match[1] === key) {
        lines[i] = `${key}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${key}: ${value}`);
    // Trim trailing empty lines
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    writeFileSync(configFile, lines.join('\n') + '\n', 'utf-8');
  } catch (err) {
    console.log(chalk.yellow('  Failed to save config:'), err instanceof Error ? err.message : String(err));
  }
}

/**
 * Register a new project or update its path.
 */
export function addProject(name: string, path: string): void {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    console.log(chalk.yellow(`  Path does not exist: ${absPath}`));
    return;
  }

  const registry = loadProjectRegistry();
  const existing = registry.projects.findIndex((p) => p.name === name);

  if (existing >= 0) {
    registry.projects[existing].path = absPath;
    registry.projects[existing].lastAccessed = Date.now();
    console.log(chalk.green(`  Updated project ${chalk.bold(name)} → ${absPath}`));
  } else {
    registry.projects.push({
      name,
      path: absPath,
      lastAccessed: Date.now(),
    });
    console.log(chalk.green(`  Registered project ${chalk.bold(name)} → ${absPath}`));
  }

  saveProjectRegistry(registry);
}

/**
 * List registered projects.
 */
export function listProjects(): void {
  const registry = loadProjectRegistry();
  if (registry.projects.length === 0) {
    console.log(chalk.dim('  No projects registered. Use: /workspace add <name> <path>'));
    return;
  }

  console.log();
  console.log(chalk.bold('  Projects:'));
  for (const proj of registry.projects) {
    const access = proj.lastAccessed ? ` ${chalk.dim(`(last: ${new Date(proj.lastAccessed).toLocaleDateString()}`)}` : '';
    const current = _activeWorkspace.project === proj.name ? chalk.cyan(' ← current') : '';
    console.log(
      `    ${chalk.cyan(proj.name.padEnd(20))} ${chalk.dim(proj.path)}${access}${current}`,
    );
  }
  console.log();
}

/**
 * Switch to a project (load context, set env vars, persist).
 * @param nameOrPath Project name from registry, or an absolute path
 */
export function switchProject(nameOrPath: string): void {
  let projectPath: string | null = null;
  let projectName: string | null = null;

  // Try registry lookup first
  const registry = loadProjectRegistry();
  const proj = registry.projects.find(
    (p) => p.name === nameOrPath || p.path === resolve(nameOrPath),
  );

  if (proj) {
    projectPath = proj.path;
    projectName = proj.name;
  } else {
    // Treat as a direct path
    const absPath = resolve(nameOrPath);
    if (!existsSync(absPath)) {
      console.log(chalk.yellow(`  Path does not exist: ${absPath}`));
      return;
    }
    projectPath = absPath;
    projectName = relative(homedir(), absPath); // Use relative path as fallback name
  }

  // Load context files
  console.log(chalk.dim(`  Loading context from ${projectPath}...`));
  const context = loadContextFiles(projectPath);
  console.log(`  ${context.summary}`);

  // Update env vars for downstream Genesis calls
  process.env.AITHER_PROJECT = projectName;
  process.env.AITHER_PROJECT_PATH = projectPath;

  // Persist
  saveConfigKey('active_project', projectName);
  saveConfigKey('project_path', projectPath);

  // Update in-memory state
  _activeWorkspace.project = projectName;
  _activeWorkspace.path = projectPath;
  _activeWorkspace.context = context;

  console.log(chalk.green(`✓ Switched to project ${chalk.bold(projectName)}`));
}

/**
 * Get the active workspace state.
 */
export function getActiveWorkspace(): ActiveWorkspace {
  return _activeWorkspace;
}

/**
 * Initialize workspace from config (called at REPL startup).
 */
export function initializeWorkspace(config: ShellConfig): void {
  // Check if activeProject is persisted in config-like fashion
  // For now, this is a no-op; the REPL can call switchProject if desired
}

/**
 * Remove a project from the registry.
 */
export function removeProject(name: string): void {
  const registry = loadProjectRegistry();
  const idx = registry.projects.findIndex((p) => p.name === name);

  if (idx < 0) {
    console.log(chalk.yellow(`  Project not found: ${name}`));
    return;
  }

  registry.projects.splice(idx, 1);
  saveProjectRegistry(registry);
  console.log(chalk.green(`  Removed project ${chalk.bold(name)}`));

  if (_activeWorkspace.project === name) {
    _activeWorkspace = {};
    process.env.AITHER_PROJECT = '';
    process.env.AITHER_PROJECT_PATH = '';
  }
}

/**
 * Get the context content for a turn (prepended to system prompt).
 * Returns empty string if no project is active.
 */
export function getWorkspaceContext(): string {
  return _activeWorkspace.context?.fullContent || '';
}

/**
 * Interactive directory browser for workspace selection.
 * Allows arrow-key navigation through the directory tree.
 * Returns the selected directory path, or null if cancelled.
 */
export async function pickDirectory(startPath?: string): Promise<string | null> {
  const { createInterface } = await import('node:readline');
  const { readdir, stat } = await import('node:fs/promises');
  const pathModule = await import('node:path');

  // Start from provided path, current directory, or home
  let currentPath = startPath
    ? pathModule.resolve(startPath)
    : process.cwd();

  // Verify starting path exists
  try {
    const stats = await stat(currentPath);
    if (!stats.isDirectory()) {
      currentPath = pathModule.resolve(homedir());
    }
  } catch {
    currentPath = pathModule.resolve(homedir());
  }

  let selectedIndex = 0;
  let directories: Array<{ name: string; path: string; isDirectory: boolean }> = [];

  // Load directories for current path
  const loadDirectories = async () => {
    try {
      const entries = await readdir(currentPath);
      directories = [];

      // Add parent directory option (unless at root)
      if (currentPath !== pathModule.resolve('/') && currentPath !== pathModule.resolve(homedir(), '..')) {
        directories.push({
          name: '..',
          path: pathModule.dirname(currentPath),
          isDirectory: true,
        });
      }

      // Add subdirectories (skip hidden dirs starting with .)
      for (const entry of entries.sort()) {
        if (entry.startsWith('.')) continue;
        const fullPath = pathModule.join(currentPath, entry);
        try {
          const st = await stat(fullPath);
          if (st.isDirectory()) {
            directories.push({
              name: entry,
              path: fullPath,
              isDirectory: true,
            });
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch (err) {
      console.log(chalk.red(`  Error reading directory: ${err instanceof Error ? err.message : String(err)}`));
      return false;
    }
    selectedIndex = Math.min(selectedIndex, Math.max(0, directories.length - 1));
    return true;
  };

  // Draw the UI
  const draw = () => {
    console.clear();
    console.log(chalk.bold(`  Directory Picker\n`));
    console.log(chalk.cyan(`  Current: ${currentPath}\n`));

    if (directories.length === 0) {
      console.log(chalk.dim('  (no subdirectories)\n'));
    } else {
      for (let i = 0; i < directories.length; i++) {
        const item = directories[i];
        const prefix = i === selectedIndex ? chalk.bgCyan(chalk.black(' ▶ ')) : '   ';
        const icon = item.name === '..' ? '📁' : '📂';
        console.log(`${prefix} ${icon} ${chalk.yellow(item.name)}`);
      }
      console.log();
    }

    console.log(chalk.dim('  ↑↓ navigate  · Enter select  · q/Esc cancel'));
  };

  // Load initial directories
  if (!(await loadDirectories())) {
    return null;
  }

  // Set up readline for key capture
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    let isHandling = false;

    // Enable raw mode for arrow key handling
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode?.(true);
      } catch {
        // Ignore errors if setRawMode fails
      }

      const restoreRawMode = () => {
        try {
          process.stdin.setRawMode?.(false);
        } catch {
          // Ignore errors
        }
      };

      const handleInput = async (chunk: Buffer) => {
        if (isHandling) return;
        isHandling = true;

        const key = chunk.toString();

        // Arrow up
        if (key === '\x1b[A' || key === 'k') {
          selectedIndex = Math.max(0, selectedIndex - 1);
          draw();
        }
        // Arrow down
        else if (key === '\x1b[B' || key === 'j') {
          selectedIndex = Math.min(directories.length - 1, selectedIndex + 1);
          draw();
        }
        // Enter / Return
        else if (key === '\r' || key === '\n') {
          if (directories.length > 0) {
            const selected = directories[selectedIndex];
            process.stdin.removeListener('data', handleInput);
            rl.close();
            restoreRawMode();
            resolve(selected.path);
            return;
          }
        }
        // Quit
        else if (key === 'q' || key === '\x1b') {
          process.stdin.removeListener('data', handleInput);
          rl.close();
          restoreRawMode();
          console.log(chalk.dim('\n  Cancelled.\n'));
          resolve(null);
          return;
        }
        // Descend into directory on 'l' or right arrow
        else if ((key === '\x1b[C' || key === 'l') && directories.length > 0) {
          currentPath = directories[selectedIndex].path;
          selectedIndex = 0;
          if (!(await loadDirectories())) {
            process.stdin.removeListener('data', handleInput);
            rl.close();
            restoreRawMode();
            resolve(null);
            return;
          }
          draw();
        }
        // Parent directory on 'h' or left arrow
        else if ((key === '\x1b[D' || key === 'h') && currentPath !== pathModule.resolve('/')) {
          currentPath = pathModule.dirname(currentPath);
          selectedIndex = 0;
          if (!(await loadDirectories())) {
            process.stdin.removeListener('data', handleInput);
            rl.close();
            restoreRawMode();
            resolve(null);
            return;
          }
          draw();
        }

        isHandling = false;
      };

      process.stdin.on('data', handleInput);

      rl.on('close', () => {
        process.stdin.removeListener('data', handleInput);
        restoreRawMode();
      });
    } else {
      // Fallback for non-TTY: use readline prompt
      rl.question(chalk.cyan('  Enter directory path: '), (input) => {
        rl.close();
        if (input.trim()) {
          const selected = pathModule.resolve(input.trim());
          resolve(selected);
        } else {
          resolve(null);
        }
      });
      return;
    }

    // Initial draw
    draw();
  });
}
