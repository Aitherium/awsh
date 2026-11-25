/**
 * `awsh avatar …` — proper terminal avatars directly from the command line.
 *
 * Works in ANY terminal, offline, with zero fleet dependencies:
 *   awsh avatar [show] [name] [--emotion E] [--protocol auto|kitty|sixel|iterm2|halfblock]
 *                             [--cols N] [--crop bust|full] [--animate]
 *   awsh avatar list          all installed characters (bundled + dev + ~/.aither/avatars)
 *   awsh avatar use <name>    set default avatar (persisted in ~/.aither/config.json)
 *   awsh avatar protocol [p]  inspect detected protocol or save preference
 *   awsh avatar demo [name]   cycle emotion expressions inline
 *   awsh avatar sync          match your active awdesk cast.json persona
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { fairyTag } from './agent-fairy.js';
import {
  avatarCropFromConfig,
  avatarProtocolFromConfig,
  personaAvatarFromCast,
} from './tui/avatar-autodock.js';
import type { PortraitCropMode } from './tui/portrait.js';
import {
  detectGraphicsProtocol,
  GRAPHICS_PROTOCOLS,
  listAvailableAvatars,
  pickAvatarStillPath,
  renderAvatarFile,
  resolveAvatarDir,
  type GraphicsProtocol,
  type ProtocolPreference,
} from './tui/terminal-graphics.js';

const CONFIG_PATH = join(homedir(), '.aither', 'config.json');

function readConfig(path = CONFIG_PATH): Record<string, any> {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function writeConfig(cfg: Record<string, any>, path = CONFIG_PATH): void {
  mkdirSync(join(homedir(), '.aither'), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8');
}

export interface AvatarCmdArgs {
  sub: 'show' | 'list' | 'use' | 'protocol' | 'crop' | 'demo' | 'sync' | 'help';
  target: string;
  emotion: string;
  protocol?: ProtocolPreference;
  cols: number;
  crop?: PortraitCropMode;
  animate: boolean;
}

export function parseAvatarArgs(argv: string[]): AvatarCmdArgs {
  const out: AvatarCmdArgs = {
    sub: 'show',
    target: '',
    emotion: 'neutral',
    cols: 28,
    animate: false,
  };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : '');
    if (a === '--help' || a === '-h') { out.sub = 'help'; return out; }
    if (a === '--emotion' || a === '--mood' || a === '-e') out.emotion = next() || 'neutral';
    else if (a === '--protocol' || a === '-p') out.protocol = next().toLowerCase() as ProtocolPreference;
    else if (a === '--cols' || a === '--width' || a === '-w') {
      const n = Number(next());
      if (Number.isFinite(n) && n >= 8 && n <= 120) out.cols = Math.floor(n);
    } else if (a === '--crop') {
      const c = next().toLowerCase();
      if (c === 'bust' || c === 'full') out.crop = c;
    } else if (a === '--full') out.crop = 'full';
    else if (a === '--bust') out.crop = 'bust';
    else if (a === '--animate' || a === '-a') out.animate = true;
    else pos.push(a);
  }
  const first = (pos[0] || '').toLowerCase();
  if (first === 'list' || first === 'ls') { out.sub = 'list'; }
  else if (first === 'use' || first === 'set') { out.sub = 'use'; out.target = pos[1] || ''; }
  else if (first === 'protocol' || first === 'proto') { out.sub = 'protocol'; out.target = pos[1] || ''; }
  else if (first === 'crop' || first === 'frame') { out.sub = 'crop'; out.target = pos[1] || ''; }
  else if (first === 'demo') { out.sub = 'demo'; out.target = pos[1] || ''; }
  else if (first === 'sync') { out.sub = 'sync'; }
  else if (first === 'show' || first === 'preview') { out.sub = 'show'; out.target = pos[1] || ''; }
  else if (first === 'help') { out.sub = 'help'; }
  else if (first) { out.sub = 'show'; out.target = first; }
  return out;
}

function usage(out: (s: string) => void): void {
  out([
    chalk.bold('awsh avatar') + ' — terminal avatars (Kitty · Sixel · iTerm2 · 24-bit half-block)',
    '',
    '  awsh avatar [show] [name]       render your avatar inline right in the terminal',
    '      --emotion <e>               neutral, happy, curious, angry, sad, love, surprised, tired',
    '      --protocol <p>              auto | kitty | sixel | iterm2 | halfblock',
    '      --cols <N>                  width in terminal columns (default 28)',
    '      --crop <bust|full>          bust (default, crisp face) or full figure',
    '      --animate                   play the animated frame loop (Ctrl+C / key stops)',
    '  awsh avatar list                list available characters (bundled + custom)',
    '  awsh avatar use <name>          set & persist active avatar (~/.aither/config.json)',
    '  awsh avatar protocol [p]        show detected terminal graphics or save preference',
    '  awsh avatar crop <bust|full>    save default portrait framing',
    '  awsh avatar demo [name]         preview multiple emotions inline',
    '  awsh avatar sync                sync active character from awdesk cast.json',
    '',
    chalk.dim('  Custom avatars: drop PNG frames into ~/.aither/avatars/<name>-portrait/'),
  ].join('\n'));
}

function resolveActiveAvatarName(explicit: string, cfg: Record<string, any>): string {
  if (explicit) return explicit.toLowerCase().replace(/-portrait$/, '');
  const available = listAvailableAvatars();
  if (typeof cfg.avatar === 'string' && cfg.avatar && cfg.avatar_set_at && resolveAvatarDir(cfg.avatar)) {
    return cfg.avatar;
  }
  const fromCast = personaAvatarFromCast('aither', available);
  if (fromCast) return fromCast;
  if (typeof cfg.avatar === 'string' && cfg.avatar && resolveAvatarDir(cfg.avatar)) return cfg.avatar;
  return available[0] || 'aither';
}

export interface AvatarCommandDeps {
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export async function runAvatarCommand(argv: string[], deps: AvatarCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const out = (line: string) => write(line + '\n');
  const env = deps.env ?? process.env;
  const cfgPath = deps.configPath ?? CONFIG_PATH;
  const parsed = parseAvatarArgs(argv);

  if (parsed.sub === 'help') {
    usage(out);
    return 0;
  }

  const cfg = readConfig(cfgPath);
  const avail = listAvailableAvatars();
  const activeName = resolveActiveAvatarName(parsed.target, cfg);
  const prefProto: ProtocolPreference = parsed.protocol || avatarProtocolFromConfig(cfg);
  const det = detectGraphicsProtocol(env, prefProto);
  const crop: PortraitCropMode = parsed.crop || avatarCropFromConfig(cfg);

  if (parsed.sub === 'list') {
    if (!avail.length) {
      out(chalk.yellow('  No portrait sets found.'));
      out(chalk.dim('  Add PNGs to ~/.aither/avatars/<name>-portrait/idle/frame_00.png'));
      return 1;
    }
    out('');
    out(chalk.bold('  Terminal Avatars') + chalk.dim(`  (protocol: ${det.protocol} · crop: ${crop})`));
    for (const name of avail) {
      const dir = resolveAvatarDir(name);
      const emotions = dir
        ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name)
        : [];
      const mark = name === activeName ? chalk.green(' ◀ active') : '';
      out(`    ${fairyTag(name)}  ${chalk.dim(`${emotions.length} clips`)}${mark}`);
    }
    out('');
    out(chalk.dim('  awsh avatar show <name>  ·  awsh avatar use <name>  ·  awsh avatar protocol'));
    return 0;
  }

  if (parsed.sub === 'protocol') {
    if (!parsed.target) {
      out(`  active protocol : ${chalk.cyan(det.protocol)}  ${chalk.dim(`(pref: ${prefProto})`)}`);
      out(`  reason          : ${chalk.dim(det.reason)}`);
      out(`  supported       : ${GRAPHICS_PROTOCOLS.join(', ')}`);
      out(chalk.dim('  set with        : awsh avatar protocol <auto|kitty|sixel|iterm2|halfblock>'));
      return 0;
    }
    const want = parsed.target.toLowerCase();
    if (!GRAPHICS_PROTOCOLS.includes(want as ProtocolPreference)) {
      out(chalk.red(`  unknown protocol "${parsed.target}" — use: ${GRAPHICS_PROTOCOLS.join(', ')}`));
      return 2;
    }
    cfg.avatar_protocol = want;
    writeConfig(cfg, cfgPath);
    const nextDet = detectGraphicsProtocol(env, want as ProtocolPreference);
    out(chalk.green(`  ✓ avatar protocol set to ${want}`) + chalk.dim(` (resolved: ${nextDet.protocol})`));
    return 0;
  }

  if (parsed.sub === 'crop') {
    const want = parsed.target.toLowerCase();
    if (want !== 'bust' && want !== 'full') {
      out(`  current crop: ${chalk.cyan(crop)}  —  use: awsh avatar crop <bust|full>`);
      return want ? 2 : 0;
    }
    cfg.avatar_crop = want;
    writeConfig(cfg, cfgPath);
    out(chalk.green(`  ✓ avatar framing set to ${want}`));
    return 0;
  }

  if (parsed.sub === 'use') {
    const want = parsed.target.toLowerCase().replace(/-portrait$/, '');
    if (!want) {
      out(`  active avatar: ${fairyTag(activeName)}  (available: ${avail.join(', ') || 'none'})`);
      return 0;
    }
    const dir = resolveAvatarDir(want);
    if (!dir) {
      out(chalk.red(`  unknown avatar "${want}" — available: ${avail.join(', ') || '(none)'}`));
      return 1;
    }
    cfg.avatar = want;
    cfg.avatar_set_at = new Date().toISOString();
    writeConfig(cfg, cfgPath);
    out(chalk.green(`  ✓ active avatar → ${want}`) + chalk.dim(` (${dir})`));
    return 0;
  }

  if (parsed.sub === 'sync') {
    const persona = personaAvatarFromCast('aither', avail);
    if (!persona) {
      out(chalk.yellow('  no matching persona found in awdesk cast.json'));
      return 1;
    }
    cfg.avatar = persona;
    cfg.avatar_set_at = new Date().toISOString();
    writeConfig(cfg, cfgPath);
    out(chalk.green(`  ✓ synced active avatar from awdesk → ${persona}`));
    return 0;
  }

  // `show` or `demo`
  const dir = resolveAvatarDir(activeName);
  if (!dir) {
    out(chalk.red(`  avatar "${activeName}" not found — available: ${avail.join(', ') || '(none)'}`));
    return 1;
  }

  const renderOne = (filePath: string, emotionLabel: string, proto: GraphicsProtocol): boolean => {
    const rendered = renderAvatarFile(filePath, {
      cols: parsed.cols,
      maxRows: 24,
      crop,
      protocol: proto,
    });
    if (!rendered) return false;
    out('');
    if (rendered.nativePayload && proto !== 'halfblock') {
      write('  ' + rendered.nativePayload + '\n');
    } else {
      for (const line of rendered.lines) out('  ' + line);
    }
    out(`  ${fairyTag(activeName)} ${chalk.dim(`· ${emotionLabel} · ${proto} · ${crop} · ${rendered.cols}×${rendered.rows}`)}`);
    return true;
  };

  if (parsed.sub === 'demo') {
    const moods = ['idle', 'happy', 'curious', 'love', 'surprised', 'angry'];
    let shown = 0;
    for (const m of moods) {
      const p = pickAvatarStillPath(dir, m);
      if (p && renderOne(p, m, det.protocol)) shown++;
    }
    if (!shown) {
      out(chalk.red(`  no decodable PNG frames found in ${dir}`));
      return 1;
    }
    out('');
    return 0;
  }

  // Single show (or --animate loop)
  if (parsed.animate) {
    const emoDir = join(dir, parsed.emotion === 'neutral' ? 'idle' : parsed.emotion);
    const frameFiles = existsSync(emoDir)
      ? readdirSync(emoDir).filter(f => /^frame_\d+\.png$/i.test(f)).sort().map(f => join(emoDir, f))
      : [];
    const fallback = pickAvatarStillPath(dir, parsed.emotion);
    const list = frameFiles.length ? frameFiles : (fallback ? [fallback] : []);
    if (!list.length) {
      out(chalk.red(`  no frames found for ${activeName}/${parsed.emotion}`));
      return 1;
    }
    const rendered = list
      .map(f => renderAvatarFile(f, { cols: parsed.cols, maxRows: 24, crop, protocol: det.protocol, imageId: 4243 }))
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (!rendered.length) return 1;
    if (!process.stdout.isTTY) {
      // Non-TTY: print frame 0 cleanly instead of hanging.
      const f0 = rendered[0];
      if (f0.nativePayload && det.protocol !== 'halfblock') write(f0.nativePayload + '\n');
      else for (const l of f0.lines) out('  ' + l);
      return 0;
    }
    let idx = 0;
    write('\x1b[?25l');
    const draw = () => {
      const fr = rendered[idx % rendered.length];
      idx++;
      write('\x1b[2J\x1b[H');
      out(`  ${fairyTag(activeName)} ${chalk.dim(`· ${parsed.emotion} · ${det.protocol} · Ctrl+C to stop`)}\n`);
      if (fr.nativePayload && det.protocol !== 'halfblock') write('  ' + fr.nativePayload + '\n');
      else for (const l of fr.lines) out('  ' + l);
    };
    draw();
    const timer = setInterval(draw, 220);
    await new Promise<void>((resolve) => {
      const done = () => { clearInterval(timer); write('\x1b[?25h\n'); resolve(); };
      process.once('SIGINT', done);
      setTimeout(done, 15_000).unref();
    });
    return 0;
  }

  const still = pickAvatarStillPath(dir, parsed.emotion);
  if (!still) {
    out(chalk.red(`  no PNG frame found for ${activeName} (${parsed.emotion}) in ${dir}`));
    return 1;
  }
  if (!renderOne(still, parsed.emotion, det.protocol)) {
    out(chalk.red(`  failed to decode ${still}`));
    return 1;
  }
  out('');
  return 0;
}
