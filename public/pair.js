// The two pure pieces of 「かんたん接続」, kept out of app.js so a test can
// import them without a DOM: the link that hands a PC everything it needs
// in one go, and the tidying of a web address someone typed by hand.
//
// No DOM, no fetch, no crypto in this file — only strings in and strings out.

/* ------------------------------------------------------------ pair link */

// multitasker://pair#v1|<origin>|<agent token>|<master key, base64url>
//
// Everything after the # is one string split on `|`. The key rides in the
// fragment on purpose: a fragment is never sent in a request, and the whole
// address is handed straight from the browser to the program registered for
// `multitasker://` — it does not touch the board's server, which never holds
// the key. The same string is what the board shows as the 「接続コード」
// when the hand-over does not happen (a phone, or a PC without the program).
//
// `|` is used rather than `&` or `/` because none of the three parts can
// contain it (an origin has scheme://host:port, a token and a key are
// base64url), and because Windows passes an argument holding it through to
// the program untouched.
//
// Windows does change one thing on the way: when it hands a custom-scheme
// link to its handler it rewrites `multitasker://pair#…` into
// `multitasker://pair/#…` (a `/` before the `#`; measured 2026-09-09). The
// board builds the link without the `/`; the reader here and the PC's copy
// (agent/src/PairLink.cs) accept both — one `/` at most, nothing else.
export const PAIR_PREFIX = 'multitasker://pair#';
export const PAIR_PREFIX_SLASH = 'multitasker://pair/#';
export const PAIR_VERSION = 'v1';

export function pairLink(origin, token, masterB64) {
  return `${PAIR_PREFIX}${PAIR_VERSION}|${String(origin)}|${String(token)}|${String(masterB64)}`;
}

// The reverse, for the test and for anyone who wants to look at one. Returns
// null for anything that is not exactly the shape above; the PC program has
// its own copy of this rule in C# (agent/src/PairLink.cs) and refuses the
// same things.
export function parsePairLink(text) {
  const s = String(text || '').trim();
  const lower = s.toLowerCase();
  let body;
  if (lower.startsWith(PAIR_PREFIX)) body = s.slice(PAIR_PREFIX.length);
  else if (lower.startsWith(PAIR_PREFIX_SLASH)) body = s.slice(PAIR_PREFIX_SLASH.length);
  else return null;
  // A browser may percent-encode the fragment on the way out; nothing in the
  // three parts contains a `%`, so undoing it is always safe.
  try { body = decodeURIComponent(body); } catch (_) { return null; }
  const parts = body.split('|');
  if (parts.length !== 4 || parts[0] !== PAIR_VERSION) return null;
  const [, origin, token, key] = parts;
  if (!/^https?:\/\/[^/\s|]+$/i.test(origin)) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return null;
  // 32 bytes of base64url without padding is exactly 43 characters.
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  return { version: PAIR_VERSION, origin, token, key };
}

/* ---------------------------------------------------------- web address */

// What a square of kind `url` stores. Someone who copies from the address bar
// gets `https://…` and is left alone; someone who types `example.com` meant
// the site, not a file called that, so `https://` is put in front. `http://`
// is accepted as it is (Owner: T-026). Anything with some other scheme is
// left as typed: the PC refuses it, and rewriting it here would hide that.
export function normalizeUrl(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;       // some other scheme — not ours to fix
  return `https://${s.replace(/^\/+/, '')}`;
}

/* ------------------------------------------------------------ typed line */

// What a square of kind `text` may hold. The PC types the line one character
// at a time, waiting 25 ms between them, which the system timer rounds up to
// about 31 ms a character (agent/src/Hotkeys.cs; the measurements are in
// docs/DECK_AGENT_PROTOCOL.md §3 `text`). The board stops waiting for an
// answer 60 seconds after the PC takes the job, so anything past roughly
// 1,900 characters can only ever come back as a failure. Without a ceiling a
// square like that can be saved and looks no different from any other — it
// just fails every time it is pressed.
//
// 500 rather than 1,900: a line typed into a game's chat is a sentence, and
// the room left over is what covers a PC slower than the one this was
// measured on (Owner: T-051 = A).
export const TEXT_MAX = 500;

// Counted in characters, not UTF-16 units, because a character is what the PC
// types and waits after — a surrogate pair goes in one call with one wait
// following it, so a character outside the basic plane counts once here as it
// does there.
export function textTooLong(text) {
  return [...String(text ?? '')].length > TEXT_MAX;
}

// How the PC types the line (T-087, Owner 2026-09-14 「切り替えできるように」).
// `burst` is the whole line in one SendInput; `paced` is one character per
// SendInput, 25 ms apart. Burst is the default (T-092, Owner 2026-09-16
// 「一気に」をデフォルトに): a square with no `mode`, or one this list does not
// know, types burst. The board always writes the mode into the sealed
// instruction (public/app.js runCommand), so the PC never has to guess.
export const TEXT_MODES = ['burst', 'paced'];

export function textMode(args) {
  return args && args.mode === 'paced' ? 'paced' : 'burst';
}

/* ------------------------------------------------------------- the phone */

// A phone cannot run the PC program, so on one the board shows the connect
// code first rather than trying the link and waiting for nothing. iPads say
// they are Macs; the touch points give them away.
export function isMobile(userAgent, maxTouchPoints = 0) {
  const ua = String(userAgent || '');
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}
