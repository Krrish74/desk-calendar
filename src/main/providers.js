// providers.js: which AI services the assistant can use.
//
// Two kinds of API are supported:
//   'anthropic'  Claude, through the official Anthropic SDK (assistant.js → runClaude).
//   'openai'     Anything that speaks the OpenAI "chat/completions" format with tool
//                calling (assistant.js → runOpenAI). That covers OpenAI itself, Google
//                Gemini's OpenAI-compatible endpoint, Groq, OpenRouter, Cerebras, and
//                local servers like Ollama and LM Studio. "Custom" takes any base URL.
//
// To add a provider: copy one of the 'openai' entries below and change the fields.
// No other code needs to change; Settings → Assistant lists every entry here.
//
// Fields
//   name          short name used in messages ("Gemini rejected the API key")
//   label         shown in Settings
//   kind          'anthropic' | 'openai'
//   baseUrl       API root; requests go to `${baseUrl}/chat/completions` and `${baseUrl}/models`
//   model         default model id (you can type another one or click "Load models")
//   keyEnv        environment variable used when no key is saved in Settings
//   keyRequired   false for local servers that don't check keys
//   keyHint       placeholder for the key box
//   keyUrl        where to get a key (shown as a link)
//   local         runs on this PC: no key, no cost, nothing leaves your computer
//   note          one line of advice under the provider picker
//   prices        optional { 'model-id': { in, out, cacheRead } } in US$ per million tokens,
//                 so Settings can show what each message cost (otherwise only token counts)
//
// Model ids change often. The defaults below were current in November 2026; if one
// stops working, click "Load models" in Settings to see what your key can use.

const PROVIDERS = {
  anthropic: {
    name: 'Claude',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyRequired: true,
    keyHint: 'sk-ant-…',
    keyPattern: /^sk-ant-/,
    keyUrl: 'https://platform.claude.com/',
    note: 'Most reliable at using the calendar tools. Pay per use (Haiku is about $0.002 a message).',
  },
  gemini: {
    name: 'Gemini',
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash-lite',
    keyEnv: 'GEMINI_API_KEY',
    keyRequired: true,
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Has a free tier (rate-limited; Google may use free-tier prompts to improve its products).',
  },
  openai: {
    name: 'OpenAI',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    keyEnv: 'OPENAI_API_KEY',
    keyRequired: true,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Pay per use. Pick the smallest model that handles your requests well.',
  },
  groq: {
    name: 'Groq',
    label: 'Groq (open models, fast)',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-20b',
    keyEnv: 'GROQ_API_KEY',
    keyRequired: true,
    keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    note: 'Hosted open models (gpt-oss, Llama). Free tier with rate limits.',
  },
  openrouter: {
    name: 'OpenRouter',
    label: 'OpenRouter (many models)',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    keyEnv: 'OPENROUTER_API_KEY',
    keyRequired: true,
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models; ids ending in ":free" cost nothing (about 50 requests a day). Pick one that supports tools.',
  },
  cerebras: {
    name: 'Cerebras',
    label: 'Cerebras (open models, fast)',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    keyEnv: 'CEREBRAS_API_KEY',
    keyRequired: true,
    keyHint: 'csk-…',
    keyUrl: 'https://cloud.cerebras.ai/',
    note: 'Hosted open models. Free trial, then pay per use.',
  },
  ollama: {
    name: 'Ollama',
    label: 'Ollama (local, free)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    keyRequired: false,
    local: true,
    note: 'Runs a model on your own PC: free and private, but needs a decent GPU or patience. Install from ollama.com, then run "ollama pull qwen3:8b".',
  },
  lmstudio: {
    name: 'LM Studio',
    label: 'LM Studio (local, free)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    keyRequired: false,
    local: true,
    note: 'Runs a model on your own PC. Load a model with tool support in LM Studio and start its local server.',
  },
  custom: {
    name: 'The server',
    label: 'Other OpenAI-compatible API',
    kind: 'openai',
    baseUrl: '',
    model: '',
    keyEnv: 'ASSISTANT_API_KEY',
    keyRequired: false,
    keyHint: 'API key (if the server needs one)',
    note: 'Any server with an OpenAI-style /chat/completions endpoint and tool calling (Cloudflare Workers AI, Together, vLLM, a company gateway…).',
  },
};

const DEFAULT_PROVIDER = 'anthropic';

/** The secureStore file name for a provider's key. Claude keeps its original name. */
const keyName = (id) => (id === 'anthropic' ? 'anthropic-key' : `assistant-key-${id}`);

/** What Settings needs to draw the picker (no secrets, no RegExps). */
function publicList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl || '',
    model: p.model || '',
    keyRequired: p.keyRequired,
    keyHint: p.keyHint || '',
    keyUrl: p.keyUrl || '',
    local: !!p.local,
    note: p.note || '',
  }));
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, keyName, publicList };
