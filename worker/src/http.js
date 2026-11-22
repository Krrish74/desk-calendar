// http.js: small helpers for building responses and reading requests.
//
// Every /api/* answer is JSON:
//   success → 200 with the data itself
//   failure → 4xx/5xx with { error: 'message for the user', code?: 'NOT_SIGNED_IN' | … }
// That mirrors the desktop app's IPC wrapper (main.js `handle`), which returned
// { ok, data } or { error, code }.

/** An error that should reach the phone with a specific HTTP status and message. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notSignedIn = (message = 'Please sign in.') => new HttpError(401, message, 'NOT_SIGNED_IN');
export const badRequest = (message) => new HttpError(400, message, 'BAD_REQUEST');

// API responses carry personal data: never cache them anywhere.
const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data ?? null), { status, headers: { ...API_HEADERS, ...extraHeaders } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
  console.error('[unhandled]', err?.stack || err);
  return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
}

/** A tiny HTML page (used by the sign-in flow for errors). Text is escaped. */
export function htmlPage(title, message, { status = 200, link } = {}) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1a1b1e;color:#e6e7ea;
font:16px/1.5 -apple-system,system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:420px}h1{font-size:20px;margin:0 0 8px}a{color:#7aa2ff}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : ''}</main></body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Parse a JSON request body, with a size cap so nobody can send us megabytes. */
export async function readJson(request, maxBytes = 64 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large.');
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw badRequest('Request body must be a JSON object.');
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/**
 * Build a Set-Cookie header. Always HttpOnly (page scripts can't read it) and
 * SameSite=Lax (other sites can't make your phone send it with a POST).
 * On https it's also Secure with the "__Host-" name prefix, which browsers only
 * accept from this exact host, so no other site can plant or overwrite it.
 */
export function setCookie(name, value, { maxAge, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

/** Cookie names: "__Host-" needs https, which `wrangler dev` on http://localhost doesn't have. */
export const cookieName = (base, secure) => (secure ? `__Host-${base}` : base);
