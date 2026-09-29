import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  // The PC program's installer (public/download/DeckAgentSetup.exe).
  '.exe': 'application/octet-stream',
};

// On every response, including the files. Set here rather than in Caddy because
// the Caddyfile is overwritten by another project's deploy, and a security
// header that disappears without anyone noticing is worse than not having one.
//
// The page loads nothing from anywhere else — no fonts, no analytics, no CDN —
// so the policy can say so flatly. The one concession is inline styles: the
// board colours each square by setting a style attribute from JavaScript, and
// that is what style-src governs. Scripts have no such exception.
const GUARDS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Only over HTTPS. Sending it from a plain-http local run would pin a browser
// to a scheme that development does not serve.
export function guards(req) {
  const proto = req && (req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http'));
  return proto === 'https'
    ? { ...GUARDS, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
    : GUARDS;
}

export function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const isJson = !(typeof body === 'string' || Buffer.isBuffer(body));
  res.writeHead(status, {
    'Content-Type': isJson ? TYPES['.json'] : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function json(res, status, obj, headers = {}) {
  send(res, status, obj, headers);
}

export async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw new Error('body is not JSON'); }
}

export function serveStatic(res, rootDir, urlPath) {
  // Resolve inside the public directory and refuse anything that escapes it,
  // which is the whole of the defence against ../ in a request path.
  const wanted = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.resolve(rootDir, '.' + wanted);
  if (!target.startsWith(path.resolve(rootDir))) return send(res, 403, 'forbidden');

  let info;
  try { info = fs.statSync(target); } catch (_) { return send(res, 404, 'not found'); }
  if (!info.isFile()) return send(res, 404, 'not found');

  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  // The service worker must not be cached or a fix can take days to reach the
  // phone; everything else may be revalidated normally.
  const cache = target.endsWith('sw.js') ? 'no-store' : 'no-cache';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': info.size });
  // Streamed rather than read whole: the installer is tens of megabytes, and
  // holding a copy of it per download is not what this process's memory is
  // for. The pages and scripts are small either way.
  fs.createReadStream(target).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
}

// Slack-shaped payloads arrive as {"text": "*session name* — 入力待ちです"}. Split the
// bold leading name off, because that name is what identifies the square. Done
// with string search rather than a pattern so the separator can be an em dash,
// a hyphen, or nothing at all.
// An address with a space around it is a different address to everything that
// compares them, and the space is invisible. Registering trimmed and signing in
// did not, so an address that picked up a space on the way into the field was
// refused with "that password is wrong" — which is what it looks like from the
// outside, and is the one thing it is not. Every address now comes through here.
export function asEmail(value) {
  return String(value || '').trim();
}
export function parseReport(payload) {
  // Optional, and absent in everything Slack-shaped, so a report without it
  // means what reports have always meant: the session has stopped.
  const event = payload && payload.event === 'start' ? 'start' : 'stop';

  // A sealed report carries no name at all: a keyed hash to match on, and the
  // name itself encrypted for whoever owns the board. Nothing here can read it,
  // which is the point.
  if (payload && payload.matchHash) {
    return {
      name: '',
      body: '',
      event,
      matchHash: String(payload.matchHash),
      nameCipher: payload.nameCipher ? String(payload.nameCipher) : null,
    };
  }

  if (payload && typeof payload.title === 'string') {
    return { name: payload.title.trim(), body: String(payload.body || '').trim(), event };
  }
  const text = String((payload && payload.text) || '').trim();
  if (!text.startsWith('*')) return { name: '', body: text, event };

  const close = text.indexOf('*', 1);
  if (close <= 1) return { name: '', body: text, event };

  const name = text.slice(1, close).trim();
  let rest = text.slice(close + 1);
  const separators = ['—', '–', '-', ':', ' '];
  while (rest.length && separators.includes(rest[0])) rest = rest.slice(1);
  return { name, body: rest.trim(), event };
}
