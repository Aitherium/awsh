/**
 * GENERATED -- do not edit. The agent fairy palette, verbatim from the canonical
 * AitherOS/config/agent-fairies.json (the desk, aitherium.com and the Discord bots
 * draw from the same file). Embedded as TS, not shipped as JSON, because the npm
 * package ships only dist JS and the bun standalone binary carries no files.
 * check_agent_fairy_palette.py AFP001 fails when it drifts; to refresh, run
 * `python AitherOS/dev/tools/check_agent_fairy_palette.py --write-awsh`.
 */
export const AGENT_FAIRIES = {
  "version": 1,
  "about": "The agent fairy palette: one entry per agent, shared by the desk fairy (Aitherium/awdesk electron/agent-fairies.json), the aitherium.com web fairy (AitherVeil) and the Discord avatars (D:/aither-media/fairy-avatars/tools/render_fairies.py). Canonical copy: config/agent-fairies.json in the platform repo. color = the Discord role colour; core = the white-hot centre; glow = the outer bloom; wings = petal|swept; ring = a ring-shaped outer glow; sparkles = the owner's glints.",
  "default": "aither",
  "aliases": {
    "demi": "demiurge",
    "owner": "aither",
    "aitherium": "aither"
  },
  "crewColor": {
    "rule": "An agent with no entry below (a crew agent raising cards) gets ONE stable colour on every surface: h = FNV-1a 32-bit (offset 0x811c9dc5, prime 0x01000193) of the trimmed lowercased name, mod 360; colour = hsl(h, 70%, 60%) as #rrggbb (each channel rounded). Generic harness names (claude-code, claude, codex, agent, session, unknown) are not agents and get no fairy. Every implementation must reproduce these vectors.",
    "vectors": {
      "a": "#e05281",
      "aeon": "#52dce0",
      "chaos": "#e0c152",
      "sample-agent": "#52e07f",
      "plutus": "#52cde0",
      "viviane": "#52e0d0",
      "zeta crew": "#e06552"
    }
  },
  "agents": {
    "aither": { "label": "Aither", "color": "#38bdf8", "core": "#fff6dc", "glow": "#ffc857", "wings": "petal", "ring": false, "sparkles": true },
    "atlas": { "label": "Atlas", "color": "#a3a3a3", "core": "#ffffff", "glow": "#a3a3a3", "wings": "petal", "ring": false, "sparkles": false },
    "demiurge": { "label": "Demiurge", "color": "#06b6d4", "core": "#ffffff", "glow": "#06b6d4", "wings": "petal", "ring": false, "sparkles": false },
    "lyra": { "label": "Lyra", "color": "#8b5cf6", "core": "#ffffff", "glow": "#8b5cf6", "wings": "petal", "ring": false, "sparkles": false },
    "iris": { "label": "Iris", "color": "#f59e0b", "core": "#ffffff", "glow": "#f59e0b", "wings": "petal", "ring": false, "sparkles": false },
    "saga": { "label": "Saga", "color": "#f472b6", "core": "#ffffff", "glow": "#f472b6", "wings": "petal", "ring": false, "sparkles": false },
    "vera": { "label": "Vera", "color": "#10b981", "core": "#ffffff", "glow": "#10b981", "wings": "petal", "ring": false, "sparkles": false },
    "hera": { "label": "Hera", "color": "#38bdf8", "core": "#ffffff", "glow": "#7dd3fc", "wings": "swept", "ring": true, "sparkles": false }
  }
} as const;
