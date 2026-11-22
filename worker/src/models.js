// models.js: which Claude models the assistant can use (Settings → Assistant → Model).
// Same list as MODELS in the desktop app's src/main/assistant.js.
//   price     US$ per million tokens: in (input), out (output), cacheRead. Cache writes cost
//             1.25 × input (CACHE_WRITE_MULTIPLIER). Used for the cost shown in Settings.
//   effort    how hard the model thinks: 'low' is faster and cheaper, 'high' more careful
//   fallback  if Claude declines a request (a rare false positive from its safety
//             classifiers), the API retries it on a suitable fallback model. Haiku 5.5
//             has no server-side fallback, so its requests leave this out.

export const MODELS = {
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 — fastest, about $0.001 per message', effort: 'medium', fallback: false, price: { in: 0.10, out: 0.50, cacheRead: 0.01 } },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 — about $0.02 per message', effort: 'medium', fallback: true, price: { in: 2.00, out: 10.00, cacheRead: 0.10 } },
  'claude-opus-5-5': { label: 'Claude Opus 5.5 — most capable, about $0.04 per message', effort: 'medium', fallback: true, price: { in: 4.00, out: 20.00, cacheRead: 0.20 } },
};

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const CACHE_WRITE_MULTIPLIER = 1.25;
