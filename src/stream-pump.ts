/**
 * stream-pump — Unix-style job control (Ctrl+Z / /fg) for a live SSE stream.
 *
 * The foreground chat used to consume its stream with a bare `for await`, so the
 * only way out of a running turn was Ctrl+C, which ABORTS it. Job control needs
 * the stream to keep running while the renderer goes away. A StreamPump owns
 * the ONE consumer of the stream and fans each event to whichever sink is
 * attached right now:
 *
 *   - foreground: the renderer is the sink; `waitForeground()` resolves
 *     'done' when the stream ends, or 'detached' the moment Ctrl+Z detaches it.
 *   - background: no sink; events are only recorded (jobs.ts reads them).
 *   - `/fg`: `attach()` replays every recorded event into a fresh renderer and
 *     then follows the live stream again.
 *
 * The SSE connection is never closed by a detach — only the renderer detaches.
 * Dependency-free on purpose so it is unit-tested without a terminal.
 */

/** Structural stand-in for client.SSEEvent — keeps this module import-free. */
export interface PumpEvent {
  type: string;
  data: any;
}

export type PumpSink = (event: PumpEvent) => void;
export type ForegroundOutcome = 'done' | 'detached';

export class StreamPump {
  /** Every event seen so far, in order — the replay log for `/fg`. */
  readonly events: PumpEvent[] = [];
  /** Resolves when the stream ends (normally or with an error). Never rejects. */
  readonly finished: Promise<void>;
  private sink: PumpSink | null;
  private _done = false;
  private _error: unknown = null;
  private waiter: { resolve: (o: ForegroundOutcome) => void; reject: (e: unknown) => void } | null = null;

  constructor(stream: AsyncIterable<PumpEvent>, sink: PumpSink | null = null) {
    this.sink = sink;
    this.finished = this.run(stream);
  }

  get done(): boolean { return this._done; }
  get error(): unknown { return this._error; }
  get attached(): boolean { return this.sink !== null; }

  private async run(stream: AsyncIterable<PumpEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        this.events.push(event);
        const sink = this.sink;
        if (sink) {
          try { sink(event); } catch { /* a renderer fault must not kill the stream */ }
        }
      }
    } catch (err) {
      this._error = err;
    }
    this._done = true;
    const w = this.waiter;
    this.waiter = null;
    if (w) {
      if (this._error) w.reject(this._error);
      else w.resolve('done');
    }
  }

  /**
   * Wait while attached. Resolves 'done' when the stream ends, 'detached' when
   * `detach()` is called first; rejects with the stream's error (e.g. an
   * AbortError from Ctrl+C) exactly as the old `for await` loop threw it.
   */
  waitForeground(): Promise<ForegroundOutcome> {
    if (this._done) {
      return this._error ? Promise.reject(this._error) : Promise.resolve('done');
    }
    return new Promise<ForegroundOutcome>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** Ctrl+Z: drop the sink, keep consuming. Returns false once the stream ended. */
  detach(): boolean {
    if (this._done) return false;
    this.sink = null;
    const w = this.waiter;
    this.waiter = null;
    w?.resolve('detached');
    return true;
  }

  /** `/fg`: replay the recorded events into `sink`, then follow the live stream. */
  attach(sink: PumpSink): void {
    for (const event of this.events) {
      try { sink(event); } catch { /* */ }
    }
    this.sink = sink;
  }
}

/* ── Ctrl+Z binding ─────────────────────────────────────────────── */

/** The subset of a readline Interface the binder touches. */
export interface SuspendReadline {
  on(event: 'SIGTSTP', listener: () => void): unknown;
  removeListener(event: 'SIGTSTP', listener: () => void): unknown;
}

/** The subset of process.stdin the binder touches. */
export interface SuspendStdin {
  on(event: 'keypress', listener: (str: unknown, key: any) => void): unknown;
  removeListener(event: 'keypress', listener: (str: unknown, key: any) => void): unknown;
}

/**
 * Route Ctrl+Z to `onSuspend` for the duration of a foreground task; returns
 * the unbind. Bound only while a task runs, so Ctrl+Z at an idle prompt keeps
 * the terminal's own behaviour (readline suspends the process when no SIGTSTP
 * listener exists).
 *
 * Node's readline emits 'SIGTSTP' on Ctrl+Z on POSIX but swallows the key on
 * win32, so there the raw keypress (ctrl + 'z') is the signal instead.
 */
export function bindSuspendKey(
  rl: SuspendReadline,
  stdin: SuspendStdin,
  platform: string,
  onSuspend: () => void,
): () => void {
  if (platform === 'win32') {
    const onKey = (_str: unknown, key: any) => {
      if (key && key.ctrl && key.name === 'z') onSuspend();
    };
    stdin.on('keypress', onKey);
    return () => { stdin.removeListener('keypress', onKey); };
  }
  const onSig = () => onSuspend();
  rl.on('SIGTSTP', onSig);
  return () => { rl.removeListener('SIGTSTP', onSig); };
}
