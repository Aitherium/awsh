/** ora, with `discardStdin: false` as the default — the REPL-safe spinner.
 *
 * ora's own default is `discardStdin: true`: while a spinner runs it attaches to
 * stdin and swallows input, and after `.stop()` readline misses the next few
 * keypresses — the measured symptom (2026-08-24) was having to press Enter ~3
 * times after any slash command before the `awsh>` prompt reacted again.
 *
 * renderer.ts:521 already carried this exact fix (`discardStdin: false`, with no
 * comment saying why) and commands.ts had 212 bare `ora(...)` calls that never
 * got it — the "fix never reached the other copy" drift class. This wrapper is
 * the one place the default lives; import ora from './spinner.js', never from
 * 'ora' directly, in any module that runs inside the REPL.
 *
 * A caller may still pass `discardStdin: true` explicitly (e.g. code that runs
 * OUTSIDE the REPL and wants ora's twitch-prevention); the wrapper only fills
 * the default in.
 */
import oraLib, { type Options, type Ora } from 'ora';

export type { Ora };

export default function ora(opts?: string | Options): Ora {
  const given: Options = typeof opts === 'string' ? { text: opts } : (opts ?? {});
  return oraLib({ discardStdin: false, ...given });
}
