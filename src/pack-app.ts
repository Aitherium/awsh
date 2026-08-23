/**
 * Launch a pack's FULL app -- `awsh <pack> --app`.
 *
 * A pack has two halves. The shell half makes awsh wear the pack's opinions;
 * this is the product itself. For GobboNet that is the chat client plus its
 * file server, which reverse-proxies /llm/* and runs detached generation jobs
 * so a reply survives the tab closing.
 *
 * THREE THINGS THIS GETS RIGHT ON PURPOSE, each one a defect somewhere else in
 * this repo already:
 *
 *   1. NO CONSOLE WINDOW. Spawning a console program from a detached process on
 *      Windows allocates a NEW console that TAKES FOCUS -- eating keystrokes
 *      from whatever the user is typing into. That is a standing gate here
 *      (four scheduled tasks were found doing it, one every five minutes), and
 *      an app launcher that steals the cursor is the same defect wearing a
 *      friendlier name.
 *
 *   2. IT WAITS AND THEN LOOKS. Spawn returns as soon as the process EXISTS,
 *      which is not the same as the server listening -- so the browser would
 *      open on a connection error and the launch would report success. This
 *      polls the app's own URL and only claims a launch once something answers.
 *
 *   3. ALREADY-RUNNING IS A SUCCESS, NOT A SECOND COPY. Two file servers on one
 *      port means the second dies immediately and the first keeps serving, so
 *      the failure is invisible and the "launch" did nothing.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash, randomBytes } from 'node:crypto';

export interface AppLaunchResult {
  ok: boolean;
  url?: string;
  detail: string;
  alreadyRunning?: boolean;
  /** Set ONLY on the run that minted it, so it can be shown exactly once. */
  newPassword?: string;
}

/**
 * Is the APP answering here -- not merely "is something listening"?
 *
 * This returned `status < 500` and therefore treated a 404 as a running app.
 * Measured 2026-08-21: an unrelated service already held :8080 and answered a
 * bare 404, so `awsh gobbonet --app` reported "already running" and opened a
 * browser on HTTP ERROR 404. The launcher never even tried to start anything,
 * and the failure was reported as a success.
 *
 * A 404 at the app's OWN url means something is listening and it is not the
 * app. That is a port CONFLICT, which is worse than nothing listening at all,
 * and it has to be distinguishable from both.
 */
export type Liveness = 'app' | 'occupied' | 'silent';

export async function probe(url: string, timeoutMs = 2000): Promise<Liveness> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // 401/403 IS the app: it answered its own URL and is demanding its login.
    // Requiring a 2xx here called a correctly-running GobboNet "occupied" --
    // the opposite of the 404 bug, and just as wrong. What distinguishes the
    // app from a squatter is that the app answers ABOUT ITSELF; a stranger on
    // the port 404s because it has never heard of this path.
    if (res.ok || res.status === 401 || res.status === 403) return 'app';
    return 'occupied';
  } catch {
    return 'silent';
  }
}

/** Back-compat: only a real 2xx counts as up. */
export async function isUp(url: string, timeoutMs = 2000): Promise<boolean> {
  return (await probe(url, timeoutMs)) === 'app';
}

/** Poll until the app answers, or give up. Returns whether it came up. */
export async function waitUntilUp(url: string, totalMs: number,
                                  stepMs = 1000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/**
 * Resolve the app script against the tree root, refusing rather than guessing.
 * A relative path that does not exist is a manifest that names something we did
 * not ship -- the same class the deploy gates call a dangling reference.
 */
export function resolveAppScript(treeRoot: string, appScript: string,
                                 packRoot?: string): string | null {
  // Candidates in order: the caller's root, then every directory above the one
  // the PACK was found in.
  //
  // The caller's root is $AITHEROS_ROOT, which goes stale -- measured
  // 2026-08-21, it still pointed at a drive demoted to bulk data, so the app
  // script resolved to nothing and the launcher correctly refused a pack whose
  // app was sitting right there beside the manifest. A pack knows where it came
  // from; that is a better answer than an env var nobody has re-checked.
  const roots = [treeRoot];
  if (packRoot) {
    let dir = packRoot;
    for (let i = 0; i < 6; i++) {
      roots.push(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const root of roots) {
    const full = join(root, appScript);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * The app's access secret, minting one on a first run.
 *
 * GobboNet stores `salt:hash` -- a salted SHA-256 of a password, never the
 * password -- and refuses to start without it: "[FATAL] No access secret
 * provided. Run launch.bat." Upstream's launcher prompts for that password on
 * first run, which a WINDOWLESS launch cannot do, so the server exited
 * instantly and invisibly and the only symptom was "nothing answered".
 *
 * A generated password is printed ONCE by the caller and stored only as a hash.
 * That is the same contract launch.bat has; the difference is that a prompt
 * nobody can see is not a contract at all.
 */
export function ensureAppSecret(secretPath: string): { secret: string; created?: string } {
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim();
    if (/^[0-9a-f]+:[0-9a-f]+$/i.test(existing)) return { secret: existing };
    // A malformed file is not a secret. Replacing it is safe -- the plaintext
    // was never stored, so nothing is being destroyed that could be recovered.
  }
  const password = randomBytes(9).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  writeFileSync(secretPath, `${salt}:${hash}`, 'utf-8');
  return { secret: `${salt}:${hash}`, created: password };
}

/** Drop a leading path separator, without a regex whose escapes keep getting
 *  mangled by the shells that edit this file. */
function stripLeadingSep(s: string): string {
  let out = s;
  const BS = String.fromCharCode(92);   // a literal backslash, unmanglable
  while (out.startsWith('/') || out.startsWith(BS)) out = out.slice(1);
  return out;
}

/**
 * Set the app's access password to one the OWNER chose.
 *
 * The launcher mints a random password on a first run so the app can start at
 * all -- upstream prompts for one, which a windowless launch cannot do. But a
 * generated secret with no way to change it is its own trap: the owner is left
 * with a credential they did not choose, cannot remember, and cannot rotate,
 * and only the salted hash is stored so it cannot be recovered either.
 *
 * Same format upstream writes (`salt:hash`, SHA-256 of salt+password), so a
 * password set here works with plain launch.bat and vice versa.
 */
export function setAppPassword(treeRoot: string,
                               pack: { name: string; appSecretFile?: string; root?: string },
                               password: string): { ok: boolean; detail: string } {
  if (!pack.appSecretFile) {
    return { ok: false, detail: `pack '${pack.name}' declares no secret file` };
  }
  if (!password || password.length < 4) {
    return { ok: false, detail: 'password must be at least 4 characters' };
  }
  const target = resolveAppScript(treeRoot, pack.appSecretFile, pack.root)
    || join(treeRoot, pack.appSecretFile);
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  try {
    writeFileSync(target, `${salt}:${hash}`, 'utf-8');
  } catch (e) {
    return { ok: false, detail: `could not write ${target}: ${(e as Error).message}` };
  }
  // Read back: a write that returns is not a write, and a password the owner
  // believes they set but did not is worse than the random one they had.
  try {
    const back = readFileSync(target, 'utf-8').trim();
    if (back !== `${salt}:${hash}`) {
      return { ok: false, detail: `wrote ${target} and it did not take` };
    }
  } catch (e) {
    return { ok: false, detail: `wrote ${target} but could not read it back` };
  }
  return { ok: true, detail: target };
}

export async function launchPackApp(
  treeRoot: string,
  pack: { name: string; appScript?: string; appUrl?: string; root?: string;
          appSecretFile?: string; appLlmPort?: string; appLlmModel?: string;
          appLlmKeyFile?: string; appSidecarScript?: string; appSearchPort?: string;
          appSearchService?: string },
  opts: { waitMs?: number } = {},
): Promise<AppLaunchResult> {
  if (!pack.appScript || !pack.appUrl) {
    return { ok: false, detail: `pack '${pack.name}' declares no app to launch` };
  }
  const script = resolveAppScript(treeRoot, pack.appScript, pack.root);
  if (!script) {
    return { ok: false,
      detail: `the pack names ${pack.appScript}, which is not in this tree` };
  }

  const before = await probe(pack.appUrl);
  if (before === 'app') {
    return { ok: true, url: pack.appUrl, alreadyRunning: true,
             detail: 'already running' };
  }
  if (before === 'occupied') {
    // Refuse rather than start a second server that will lose the bind and die
    // silently, leaving the wrong thing serving the app's address.
    return { ok: false, url: pack.appUrl,
      detail: `something else is already listening on ${new URL(pack.appUrl).host} `
            + 'and it is not this app (it answered, but not with the page). '
            + 'Free that port, or point the app elsewhere -- starting a second '
            + 'server here would lose the bind and exit without saying so.' };
  }

  // Mint the access secret if this is a first run, so the server does not exit
  // instantly and invisibly on a missing password.
  let newPassword: string | undefined;
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (pack.appSecretFile) {
    // NOTE: minting is IRREVERSIBLE -- only the salted hash is stored, so a
    // password not shown is a password gone. It is therefore reported through
    // `newPassword` on EVERY return path below, including the failures. It was
    // originally only printed on success, and a launch that minted a secret and
    // then failed to bind left the user at a login box for an account whose
    // password had never existed anywhere but in that process's memory.
    const secretPath = resolveAppScript(treeRoot, pack.appSecretFile, pack.root)
      || join(dirname(script), pack.appSecretFile.split('/').pop()!);
    try {
      const { secret, created } = ensureAppSecret(secretPath);
      env.GEMMA_ACCESS_SECRET = secret;
      newPassword = created;
    } catch (e) {
      return { ok: false, detail: `could not prepare the app secret: ${(e as Error).message}` };
    }
  }

  // Point the app's inference proxy at the backend the PACK declares, not at
  // whatever happens to answer upstream's default port. Discovering a backend
  // by probing is how this ended up talking to a stray local process instead of
  // the platform; a declaration cannot drift that way.
  if (pack.appLlmPort) env.GEMMA_LLM_PORT = pack.appLlmPort;
  if (pack.appLlmModel) env.GEMMA_LLM_MODEL = pack.appLlmModel;
  if (pack.appLlmKeyFile) {
    const keyPath = pack.appLlmKeyFile.startsWith('~')
      ? join(homedir(), stripLeadingSep(pack.appLlmKeyFile.slice(1)))
      : (resolveAppScript(treeRoot, pack.appLlmKeyFile, pack.root) || pack.appLlmKeyFile);
    try {
      const key = readFileSync(keyPath, 'utf-8').trim();
      if (key) env.GEMMA_LLM_API_KEY = key;
    } catch {
      // Not fatal: the app still starts and says OFFLINE, which is the honest
      // outcome for "the backend needs a credential we do not have".
    }
  }

  // Single-quote for PowerShell, doubling any embedded quote.
  const q = (s: string) => "'" + s.split("'").join("''") + "'";

  // The SEARCH sidecar. Upstream forwards /search/* to GEMMA_SEARCH_PORT, so
  // starting our proxy there is the whole integration -- no upstream change.
  // Started BEFORE the app so the first health poll finds it, and started the
  // same detached way for the same reason (a console here would steal focus).
  if (pack.appSidecarScript && pack.appSearchPort) {
    env.GEMMA_SEARCH_PORT = pack.appSearchPort;
    const side = resolveAppScript(treeRoot, pack.appSidecarScript, pack.root);
    if (side) {
      const already = await probe(`http://127.0.0.1:${pack.appSearchPort}/health`, 1500);
      if (already !== 'app') {
        const sideCmd = `Start-Process python -ArgumentList ${q(side)} -WindowStyle Hidden`;
        try {
          const s = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', sideCmd], {
            cwd: dirname(side), windowsHide: true, stdio: 'ignore',
            env: { ...env, GOBBONET_SEARCH_PORT: pack.appSearchPort,
                   ...(pack.appSearchService
                       ? { AITHER_SEARCH_URL: pack.appSearchService } : {}) },
          });
          s.unref();
        } catch { /* the app still runs; search just reports unavailable */ }
      }
    }
  }

  // DETACHING ON WINDOWS, correctly, which took three tries.
  //
  //   detached:true  -- DETACHED_PROCESS, so the child gets NO console. pwsh
  //                     cannot initialise its host without one and dies
  //                     instantly, writing nothing anywhere. Measured: the
  //                     redirected log was byte-empty, so the only symptom was
  //                     "nothing answered" -- indistinguishable from a slow
  //                     start or a bad port.
  //   detached:false -- starts fine and is killed the moment this shell exits,
  //                     which for a server is the same as not starting.
  //
  // What works is a SHORT-LIVED launcher whose only job is Start-Process, which
  // creates a process that outlives its parent. The payload runs under
  // wscript.exe -- a GUI-subsystem host, so no console is allocated and nothing
  // flashes. That shim is the house mechanism for this exact problem (a console
  // that appears on the desktop steals focus and eats keystrokes, which is a
  // standing gate here); `-WindowStyle Hidden` alone is NOT equivalent, because
  // the console is allocated before anything can hide it.
  const shim = join(process.env.USERPROFILE || homedir(), '.aither', 'bin', 'run-hidden.vbs');
  const payload = ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                   '-File', script];
  const argList = existsSync(shim)
    ? ['//B', '//Nologo', shim, ...payload].map(q).join(',')
    : null;
  const launcher = argList
    ? `Start-Process wscript.exe -ArgumentList ${argList} -WindowStyle Hidden`
    // No shim: Start-Process the payload directly. A console is allocated and
    // hidden, so this can flash briefly -- worse, but still better than not
    // launching, and it is reported rather than pretended away.
    : `Start-Process ${q(payload[0])} -ArgumentList ${payload.slice(1).map(q).join(',')} -WindowStyle Hidden`;

  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', launcher], {
    cwd: dirname(script),
    windowsHide: true,
    stdio: 'ignore',
    env: { ...env, GEMMA_LISTEN_PORT: new URL(pack.appUrl).port || '8080' },
  });
  child.unref();

  const up = await waitUntilUp(pack.appUrl, opts.waitMs ?? 25000);
  if (!up) {
    return { ok: false, url: pack.appUrl, newPassword,
      detail: `started ${pack.appScript} but nothing answered ${pack.appUrl}. `
            + 'The process may still be starting, or it exited -- it runs '
            + 'windowless, so run the script directly to see its output.' };
  }
  return { ok: true, url: pack.appUrl, detail: 'serving', newPassword };
}
