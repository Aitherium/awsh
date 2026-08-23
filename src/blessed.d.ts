/**
 * Minimal ambient declaration for neo-blessed.
 *
 * neo-blessed ships no types and the stale @types/blessed lags its API, so we
 * declare it loosely as `any`-shaped. The TUI code accesses it via
 * `createRequire(import.meta.url)('neo-blessed')` (CommonJS-in-ESM), which is
 * already typed `any` by NodeRequire — this module just keeps a bare
 * `import 'neo-blessed'` from erroring if one is ever added.
 */
declare module 'neo-blessed' {
  const blessed: any;
  export = blessed;
}
