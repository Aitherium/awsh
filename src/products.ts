/**
 * Product scaffolding and deployment CLI commands.
 *
 * Commands:
 *   aither products init --name=MyProduct --port=8902 --category=business_agent
 *   aither products deploy --name=myproduct --subdomain=myproduct
 *   aither products list
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import type { CommandHandler } from './commands.js';

// Parse --key=value flags from args string
function parseFlags(args: string): Record<string, string> {
  const flags: Record<string, string> = {};
  const matches = args.matchAll(/--(\w[\w-]*)=([^\s]+)/g);
  for (const m of matches) {
    flags[m[1]] = m[2];
  }
  // Also handle --flag value pattern
  const parts = args.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('--') && !parts[i].includes('=') && i + 1 < parts.length && !parts[i + 1].startsWith('--')) {
      flags[parts[i].slice(2)] = parts[i + 1];
    }
  }
  return flags;
}

function findAitherOSRoot(): string {
  // Walk up from this file to find AitherOS root
  let dir = resolve('.');
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'AitherOS', 'config', 'services.yaml'))) return dir;
    if (existsSync(resolve(dir, 'config', 'services.yaml'))) return resolve(dir, '..');
    dir = resolve(dir, '..');
  }
  return resolve('.');
}

export const productsInit: CommandHandler = async (_client, args, _config) => {
  const flags = parseFlags(args);
  const name = flags['name'];
  const port = flags['port'] || '8900';
  const category = flags['category'] || 'business_agent';
  const description = flags['description'] || '';

  if (!name) {
    console.log(chalk.red('Usage: aither products init --name=MyProduct --port=8902 --category=business_agent'));
    console.log(chalk.dim('Categories: business_agent, knowledge_agent, creative_agent'));
    return;
  }

  const spinner = ora(`Scaffolding product "${name}"...`).start();

  try {
    const root = findAitherOSRoot();
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const script = `
import sys
sys.path.insert(0, "${resolve(root, 'AitherOS').replace(/\\/g, '/')}")
from lib.products.scaffold import scaffold_product
result = scaffold_product(
    name="${name}",
    category="${category}",
    port=${port},
    description="${description}",
)
print(str(result))
`;
    const result = execSync(`${pythonCmd} -c "${script.replace(/"/g, '\\"').replace(/\n/g, ';')}"`, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();

    spinner.succeed(chalk.green(`Product scaffolded at: ${result}`));
    console.log(chalk.dim(`\nNext steps:`));
    console.log(chalk.dim(`  1. cd ${result}`));
    console.log(chalk.dim(`  2. Edit .env with your config`));
    console.log(chalk.dim(`  3. docker compose -f docker-compose.yml -f docker-compose.aitheros.yml up -d --build`));
    console.log(chalk.dim(`  4. aither products deploy --name=${name.toLowerCase()} --subdomain=${name.toLowerCase()}`));
  } catch (err: any) {
    spinner.fail(chalk.red(`Scaffold failed: ${err.message}`));
  }
};

export const productsDeploy: CommandHandler = async (client, args, _config) => {
  const flags = parseFlags(args);
  const name = flags['name'];
  const subdomain = flags['subdomain'] || name;

  if (!name) {
    console.log(chalk.red('Usage: aither products deploy --name=myproduct --subdomain=myproduct'));
    return;
  }

  const spinner = ora(`Deploying ${name} to ${subdomain}.aitherium.com...`).start();

  try {
    // Call Genesis product deploy endpoint
    const resp = await client.post('/products/deploy', {
      product_name: name,
      subdomain: subdomain,
    });

    if (resp.status === 'ok' || resp.deployed) {
      spinner.succeed(chalk.green(`Deployed ${name} at https://${subdomain}.aitherium.com`));
    } else {
      spinner.warn(chalk.yellow(`Deploy returned: ${JSON.stringify(resp)}`));
    }
  } catch (err: any) {
    spinner.fail(chalk.red(`Deploy failed: ${err.message}`));
    console.log(chalk.dim('Ensure Genesis is running and the product containers are up.'));
  }
};

export const productsList: CommandHandler = async (_client, _args, _config) => {
  const root = findAitherOSRoot();
  const templatesPath = resolve(root, 'AitherOS', 'config', 'product_templates.yaml');

  if (!existsSync(templatesPath)) {
    console.log(chalk.dim('No products registered yet. Use `aither products init` to create one.'));
    return;
  }

  try {
    const content = readFileSync(templatesPath, 'utf-8');
    // Simple YAML parsing for the products list
    const lines = content.split('\n');
    const products: Array<{ name: string; slug: string; port: string; category: string }> = [];
    let current: any = null;

    for (const line of lines) {
      if (line.match(/^\s*- name:/)) {
        if (current) products.push(current);
        current = { name: line.split(':')[1]?.trim() || '', slug: '', port: '', category: '' };
      } else if (current && line.match(/^\s+slug:/)) {
        current.slug = line.split(':')[1]?.trim() || '';
      } else if (current && line.match(/^\s+port:/)) {
        current.port = line.split(':')[1]?.trim() || '';
      } else if (current && line.match(/^\s+category:/)) {
        current.category = line.split(':')[1]?.trim() || '';
      }
    }
    if (current) products.push(current);

    if (products.length === 0) {
      console.log(chalk.dim('No products registered.'));
      return;
    }

    console.log(chalk.bold('\nRegistered Products:\n'));
    console.log(chalk.dim('  Name'.padEnd(20) + 'Port'.padEnd(8) + 'Category'.padEnd(20) + 'URL'));
    console.log(chalk.dim('  ' + '-'.repeat(70)));
    for (const p of products) {
      const url = `https://${p.slug}.aitherium.com`;
      console.log(`  ${chalk.cyan(p.name.padEnd(18))}${p.port.padEnd(8)}${chalk.dim(p.category.padEnd(20))}${chalk.underline(url)}`);
    }
    console.log('');
  } catch (err: any) {
    console.log(chalk.red(`Failed to read product templates: ${err.message}`));
  }
};
