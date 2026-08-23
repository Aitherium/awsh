/**
 * AitherSense affect poller — polls GET :8096/affect (HTTPS with self-signed CA,
 * fallback to HTTP) and parses the response into a typed Affect structure.
 *
 * AitherSense exposes the live sensory/affect state: valence (positive/negative),
 * arousal (alert/calm), confidence, openness, existential depth, dominant sensation,
 * active sensation count, mood label, and a prompt modifier hint for the LLM.
 *
 * Network errors are swallowed; the poller retains the last good value. This keeps
 * the affect panel responsive even when AitherSense is temporarily down.
 */

import https from 'node:https';
import http from 'node:http';

/**
 * The affect state: valence (-1 to 1), arousal (0 to 1), confidence (0 to 1),
 * openness (0 to 1), existential depth (0 to 1), and three string fields.
 */
export interface Affect {
  valence: number;
  arousal: number;
  confidence: number;
  openness: number;
  existentialDepth: number;
  dominantSensation: string;
  activeCount: number;
  mood: string;
  promptModifier: string;
}

/**
 * Parse a JSON response from the affect endpoint, converting snake_case to
 * camelCase and providing sensible defaults (0 for numbers, '' for strings).
 * Tolerant of missing fields.
 */
export function parseAffect(json: any): Affect {
  return {
    valence: typeof json?.valence === 'number' ? json.valence : 0,
    arousal: typeof json?.arousal === 'number' ? json.arousal : 0,
    confidence: typeof json?.confidence === 'number' ? json.confidence : 0,
    openness: typeof json?.openness === 'number' ? json.openness : 0,
    existentialDepth: typeof json?.existential_depth === 'number' ? json.existential_depth : 0,
    dominantSensation: typeof json?.dominant_sensation === 'string' ? json.dominant_sensation : '',
    activeCount: typeof json?.active_sensation_count === 'number' ? json.active_sensation_count : 0,
    mood: typeof json?.mood === 'string' ? json.mood : '',
    promptModifier: typeof json?.prompt_modifier === 'string' ? json.prompt_modifier : '',
  };
}

/**
 * Poller for the affect endpoint. Polls at a fixed interval and invokes
 * onUpdate() when the value changes. Network errors are swallowed; the
 * poller retains the last good value.
 */
export interface AffectPollerOptions {
  /** Service base (default local https://127.0.0.1:8096); the gateway origin when remote. */
  baseUrl?: string;
  /** Auth headers (Bearer + X-API-Key) when routed through the gateway. */
  headers?: Record<string, string>;
  intervalMs?: number;
}

export class AffectPoller {
  private baseUrl: string;
  private headers: Record<string, string>;
  private intervalMs: number;
  private _currentAffect: Affect | null = null;
  private timerHandle: NodeJS.Timeout | null = null;
  private callbacks: Array<(affect: Affect) => void> = [];

  constructor(opts: AffectPollerOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://127.0.0.1:8096').replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    this.intervalMs = opts.intervalMs ?? 2500;
  }

  /**
   * Start polling the affect endpoint. Polls immediately, then every intervalMs.
   */
  start(): void {
    if (this.timerHandle) return; // already running
    this.poll();
    this.timerHandle = setInterval(() => this.poll(), this.intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * Get the current affect state, or null if no successful poll yet.
   */
  current(): Affect | null {
    return this._currentAffect;
  }

  /**
   * Register a callback to be invoked when the affect changes.
   */
  onUpdate(cb: (affect: Affect) => void): void {
    this.callbacks.push(cb);
  }

  /**
   * Poll the affect endpoint once. Try HTTPS first with rejectUnauthorized: false,
   * then fallback to HTTP. Never throws.
   */
  private async poll(): Promise<void> {
    try {
      const data = await this.fetchAffect();
      const parsed = parseAffect(data);

      // Check if the value has changed
      const changed = !this._currentAffect || this.hasChanged(this._currentAffect, parsed);
      this._currentAffect = parsed;

      if (changed) {
        for (const cb of this.callbacks) {
          try {
            cb(parsed);
          } catch {
            // swallow callback errors
          }
        }
      }
    } catch {
      // swallow network errors; retain last value
    }
  }

  /**
   * Fetch the affect JSON from the endpoint. Try HTTPS first, then HTTP.
   */
  private async fetchAffect(): Promise<any> {
    try {
      return await this.fetchUrl(`${this.baseUrl}/affect`, { rejectUnauthorized: false, headers: this.headers });
    } catch {
      // HTTP fallback ONLY for a local https endpoint (dev). Remote/gateway stays HTTPS.
      if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(this.baseUrl)) {
        return await this.fetchUrl(`${this.baseUrl.replace('https://', 'http://')}/affect`, { headers: this.headers });
      }
      throw new Error('affect unreachable');
    }
  }

  /**
   * Fetch a URL and parse the response as JSON. Uses node:https or node:http.
   */
  private fetchUrl(url: string, reqOpts?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https');
      const client = isHttps ? https : http;
      const opts: any = { ...(reqOpts || {}) };
      if (!isHttps) delete opts.rejectUnauthorized;   // http.get rejects unknown option in strict envs

      const req = client.get(url, opts, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch {
            reject(new Error('JSON parse error'));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      // Timeout after 3 seconds
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  /**
   * Check if the affect has meaningfully changed (more than just rounding noise).
   */
  private hasChanged(prev: Affect, next: Affect): boolean {
    const numThreshold = 0.01; // ignore tiny numeric changes
    return (
      Math.abs(prev.valence - next.valence) > numThreshold ||
      Math.abs(prev.arousal - next.arousal) > numThreshold ||
      Math.abs(prev.confidence - next.confidence) > numThreshold ||
      Math.abs(prev.openness - next.openness) > numThreshold ||
      Math.abs(prev.existentialDepth - next.existentialDepth) > numThreshold ||
      prev.dominantSensation !== next.dominantSensation ||
      prev.activeCount !== next.activeCount ||
      prev.mood !== next.mood ||
      prev.promptModifier !== next.promptModifier
    );
  }
}
