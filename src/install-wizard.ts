/**
 * AitherShell Installer Wizard
 * ===========================
 *
 * Non-technical user flow: one-click installer via interactive prompts.
 * Guides the user through device-flow login, license provisioning,
 * endpoint registration, and adk quickstart bootstrap.
 *
 * Endpoints called:
 *   POST /v1/licenses/issue       (Bearer token auth)
 *   POST /v1/endpoints/register   (X-License-Key header)
 *   POST /v1/workspace/sync       (X-License-Key header)
 */

import { execSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import {
  requestDeviceCode,
  pollDeviceToken,
  buildProfile,
  setProfile,
} from './auth.js';

/* ── Types ───────────────────────────────────────────────────── */

interface SystemInfo {
  cpu_count: number;
  gpu_name?: string;
  gpu_vram?: number;
  models_present: string[];
}

interface LicenseIssueRequest {
  tier_request: string;
  hardware_id?: string;
}

interface LicenseIssueResponse {
  license_key: string;
  tier: string;
  entitlements: Record<string, unknown>;
  expires_at: number;
  sync_interval: number;
}

interface EndpointRegisterRequest {
  node_id: string;
  hostname: string;
  system_info: SystemInfo;
  license_key: string;
}

interface EndpointRegisterResponse {
  endpoint_id: string;
  tenant_id: string;
  workspace_id: string;
  sync_interval: number;
}

interface WorkspaceSyncRequest {
  workspace_id: string;
  heartbeat?: boolean;
  local_agent_roster?: string[];
}

interface WorkspaceSyncResponse {
  agent_roster: Record<string, unknown>[];
  provider_key_refs: string[];
  settings: Record<string, unknown>;
  cache_ttl: number;
}

/* ── Onboarding Client ───────────────────────────────────────── */

export class OnboardingClient {
  private portalUrl: string;
  private authToken: string | null = null;

  constructor(portalUrl: string = 'https://portal.aitherium.com') {
    this.portalUrl = portalUrl.replace(/\/+$/, '');
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * POST /v1/licenses/issue — Mint a license.
   * Requires: Bearer token in Authorization header
   * Returns: license_key, tier, entitlements, expires_at
   */
  async issueLicense(
    tierRequest: string,
    hardwareId?: string,
  ): Promise<LicenseIssueResponse> {
    if (!this.authToken) {
      throw new Error('Not authenticated — run device-flow login first');
    }

    const body: LicenseIssueRequest = { tier_request: tierRequest };
    if (hardwareId) body.hardware_id = hardwareId;

    const resp = await fetch(`${this.portalUrl}/v1/licenses/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `License issue failed (HTTP ${resp.status}): ${text}`,
      );
    }

    return resp.json() as Promise<LicenseIssueResponse>;
  }

  /**
   * POST /v1/endpoints/register — Register a compute endpoint.
   * Requires: license_key in request body
   * Returns: endpoint_id, tenant_id, workspace_id, sync_interval
   */
  async registerEndpoint(
    licenseKey: string,
    nodeId: string,
    hostname: string,
    systemInfo: SystemInfo,
  ): Promise<EndpointRegisterResponse> {
    const body: EndpointRegisterRequest = {
      node_id: nodeId,
      hostname,
      system_info: systemInfo,
      license_key: licenseKey,
    };

    const resp = await fetch(`${this.portalUrl}/v1/endpoints/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `Endpoint register failed (HTTP ${resp.status}): ${text}`,
      );
    }

    return resp.json() as Promise<EndpointRegisterResponse>;
  }

  /**
   * POST /v1/workspace/sync — Sync workspace configuration.
   * Requires: X-License-Key header
   * Returns: agent_roster, provider_key_refs, settings, cache_ttl
   */
  async syncWorkspace(
    licenseKey: string,
    workspaceId: string,
  ): Promise<WorkspaceSyncResponse> {
    const body: WorkspaceSyncRequest = {
      workspace_id: workspaceId,
      heartbeat: false,
    };

    const resp = await fetch(`${this.portalUrl}/v1/workspace/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': licenseKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `Workspace sync failed (HTTP ${resp.status}): ${text}`,
      );
    }

    return resp.json() as Promise<WorkspaceSyncResponse>;
  }
}

/* ── System Detection ────────────────────────────────────────── */

/**
 * Detect CPU count (always available).
 */
function detectCpuCount(): number {
  return cpus().length;
}

/**
 * Best-effort GPU detection via nvidia-smi (NVIDIA only).
 * Returns { name, vram } or null if not found.
 */
function detectGpu(): { name: string; vram: number } | null {
  try {
    const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = out.split(',').map((s) => s.trim());
    if (parts.length >= 2) {
      const name = parts[0];
      const vramMb = parseInt(parts[1].replace(/[^0-9]/g, ''), 10);
      return { name, vram: vramMb };
    }
  } catch {
    // nvidia-smi not found or failed — skip
  }
  return null;
}

/**
 * Collect basic system info for the portal.
 */
export function collectSystemInfo(): SystemInfo {
  const info: SystemInfo = {
    cpu_count: detectCpuCount(),
    models_present: [],
  };

  const gpu = detectGpu();
  if (gpu) {
    info.gpu_name = gpu.name;
    info.gpu_vram = gpu.vram;
  }

  return info;
}

/**
 * Check if Docker is running (best-effort).
 * Returns true if 'docker ps' succeeds, false otherwise.
 */
export function isDockerRunning(): boolean {
  try {
    execSync('docker ps', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if 'adk' command is on PATH.
 */
export function isAdkAvailable(): boolean {
  try {
    execSync('adk --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/* ── Installation Flow ───────────────────────────────────────── */

/**
 * Run the interactive installation wizard.
 *
 * Flow:
 *   1. Welcome banner
 *   2. Check Docker (optional)
 *   3. Device-flow portal login
 *   4. Request license tier
 *   5. Detect system info
 *   6. Register endpoint
 *   7. Sync workspace
 *   8. Run 'adk quickstart-local' (bootstrap Ollama + model)
 *   9. Persist workspace config
 *   10. Print success message
 */
export async function runWizard(
  client: GenesisClient,
  config: ShellConfig,
): Promise<void> {
  console.log();
  console.log(chalk.bold(chalk.cyan('╔════════════════════════════════════════╗')));
  console.log(chalk.bold(chalk.cyan('║   AitherOS Installer Wizard             ║')));
  console.log(chalk.bold(chalk.cyan('╚════════════════════════════════════════╝')));
  console.log();

  // ── Step 1: Check Docker ──────────────────────────────────────────
  console.log(chalk.bold('Step 1: Pre-flight checks'));
  const spinner = ora({ prefixText: '  ' });

  spinner.start('Checking Docker...');
  const dockerRunning = isDockerRunning();
  if (dockerRunning) {
    spinner.succeed('Docker is running');
  } else {
    spinner.warn('Docker not running');
    console.log();
    console.log(
      chalk.yellow(
        '  ⚠ Docker is recommended for full AitherOS features.',
      ),
    );
    console.log(chalk.dim('    Install: https://docker.com'));
    console.log(chalk.dim('    Or use standalone ADK: pip install awdk'));
    console.log();
  }

  // ── Step 2: Device-flow login ────────────────────────────────────
  console.log();
  console.log(chalk.bold('Step 2: Sign in to your account'));
  console.log();

  let authToken: string | null = null;
  try {
    const dc = await requestDeviceCode(
      config.identityUrl,
      'AitherShell-Installer',
    );

    console.log('  Open this URL in your browser:');
    console.log('  ' + chalk.cyan.underline(
      dc.verification_uri_complete || dc.verification_uri,
    ));
    if (dc.user_code) {
      console.log();
      console.log('  Code: ' + chalk.bold.yellow(dc.user_code));
    }
    console.log();

    spinner.start('Waiting for authorization');
    const deadline = Date.now() + (dc.expires_in || 900) * 1000;
    const interval = Math.max(2, dc.interval || 5) * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      try {
        const result = await pollDeviceToken(config.identityUrl, dc.device_code);
        if (
          (result.status === 'complete' || result.status === 'authorized') &&
          result.access_token
        ) {
          authToken = result.access_token;
          const profile = buildProfile(
            config.identityUrl,
            config.genesisUrl,
            result,
          );
          setProfile('local', profile);
          config.authToken = authToken;
          config.authUser = profile.user;
          spinner.succeed(
            chalk.green(
              `Signed in as ${profile.user.display_name || profile.user.username}`,
            ),
          );
          break;
        }
      } catch (err: any) {
        if (String(err?.message || '').includes('expired')) {
          spinner.fail('Device code expired');
          throw err;
        }
      }
    }

    if (!authToken) {
      spinner.fail('Sign-in timed out');
      throw new Error('Authorization timeout');
    }
  } catch (err: any) {
    console.log();
    console.error(chalk.red(`  Error during sign-in: ${err.message}`));
    process.exit(1);
  }

  console.log();

  // ── Step 3: Issue license ────────────────────────────────────────
  console.log(chalk.bold('Step 3: Provision license'));
  const onboarding = new OnboardingClient(
    process.env.AITHER_PORTAL_URL || 'https://portal.aitherium.com',
  );
  onboarding.setAuthToken(authToken);

  let licenseKey: string;
  let workspaceId: string;

  spinner.start('Requesting license...');
  try {
    const licenseResp = await onboarding.issueLicense('developer');
    licenseKey = licenseResp.license_key;
    spinner.succeed(
      `License issued: ${licenseResp.tier} (expires ${new Date(licenseResp.expires_at * 1000).toLocaleDateString()})`,
    );
  } catch (err: any) {
    spinner.fail(`License request failed: ${err.message}`);
    console.error(chalk.red(`  ${err.message}`));
    process.exit(1);
  }

  console.log();

  // ── Step 4: Collect system info ──────────────────────────────────
  console.log(chalk.bold('Step 4: Detect system hardware'));
  spinner.start('Collecting system info...');
  const systemInfo = collectSystemInfo();
  spinner.succeed(
    `CPU: ${systemInfo.cpu_count} cores${systemInfo.gpu_name ? `, GPU: ${systemInfo.gpu_name}` : ''}`,
  );

  console.log();

  // ── Step 5: Register endpoint ────────────────────────────────────
  console.log(chalk.bold('Step 5: Register endpoint'));
  const nodeId = process.env.HOSTNAME || randomUUID().slice(0, 12);
  const hostname = nodeId;

  spinner.start('Registering endpoint...');
  try {
    const regResp = await onboarding.registerEndpoint(
      licenseKey,
      nodeId,
      hostname,
      systemInfo,
    );
    workspaceId = regResp.workspace_id;
    spinner.succeed(
      `Endpoint registered: ${regResp.endpoint_id}`,
    );
  } catch (err: any) {
    spinner.fail(`Endpoint registration failed: ${err.message}`);
    console.error(chalk.red(`  ${err.message}`));
    process.exit(1);
  }

  console.log();

  // ── Step 6: Sync workspace ───────────────────────────────────────
  console.log(chalk.bold('Step 6: Sync workspace'));
  spinner.start('Syncing workspace configuration...');
  try {
    await onboarding.syncWorkspace(licenseKey, workspaceId);
    spinner.succeed('Workspace synced');
  } catch (err: any) {
    spinner.warn(`Workspace sync failed (non-fatal): ${err.message}`);
  }

  console.log();

  // ── Step 7: ADK Quickstart ───────────────────────────────────────
  console.log(chalk.bold('Step 7: Bootstrap ADK and models'));
  console.log();

  let adkAvailable = isAdkAvailable();
  if (!adkAvailable) {
    spinner.start('Installing awdk...');
    try {
      execSync('pip install awdk', { stdio: 'inherit', timeout: 60000 });
      spinner.succeed('awdk installed');
      adkAvailable = true;
    } catch (err: any) {
      spinner.warn(
        'Could not auto-install awdk. Please run: pip install awdk',
      );
    }
  }

  if (adkAvailable) {
    console.log();
    console.log(chalk.dim('  Running: adk quickstart-local'));
    console.log(chalk.dim('  (This bootstraps Ollama and downloads a model — may take a few minutes)'));
    console.log();
    try {
      execSync('adk quickstart-local', { stdio: 'inherit' });
    } catch (err: any) {
      console.error(chalk.yellow('\n  ⚠ ADK quickstart encountered an error'));
      console.error(chalk.dim(`  Error: ${err.message}`));
      console.log();
      console.log(chalk.dim('  You can retry manually: adk quickstart-local'));
    }
  }

  console.log();

  // ── Step 8: Persist workspace config ─────────────────────────────
  console.log(chalk.bold('Step 8: Save configuration'));
  const configDir = join(homedir(), '.aither');
  const workspaceConfPath = join(configDir, 'workspace.conf');

  const workspaceConf = {
    workspace_id: workspaceId,
    license_key: licenseKey,
    node_id: nodeId,
    endpoint_id: nodeId,
    registered_at: new Date().toISOString(),
  };

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(workspaceConfPath, JSON.stringify(workspaceConf, null, 2), 'utf-8');
    try {
      chmodSync(workspaceConfPath, 0o600);
    } catch {
      // Windows — ignore chmod errors
    }
    spinner.succeed(`Workspace config saved to ${workspaceConfPath}`);
  } catch (err: any) {
    spinner.warn(`Could not save workspace config: ${err.message}`);
  }

  console.log();

  // ── Success banner ───────────────────────────────────────────────
  console.log(chalk.green(chalk.bold('✓ Installation complete!')));
  console.log();
  console.log('  Next steps:');
  console.log();
  console.log(chalk.cyan('  1. Start the shell:'));
  console.log(chalk.dim('     aither'));
  console.log();
  console.log(chalk.cyan('  2. View dashboard (if Docker is running):'));
  console.log(chalk.dim('     http://localhost:3000'));
  console.log();
  console.log(chalk.cyan('  3. Try a quick command:'));
  console.log(chalk.dim('     aither "What services are running?"'));
  console.log();

  if (!dockerRunning) {
    console.log(chalk.yellow('  ℹ Docker is not running.'));
    console.log(chalk.dim('    Start Docker Desktop to unlock the full dashboard and GPU inference.'));
    console.log();
  }
}
