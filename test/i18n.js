// Two languages drift apart quietly: a key gets added to one book, the other
// screen falls back to English, and nobody notices because the fallback looks
// deliberate. So the books are held side by side here, and the page is checked
// for sentences that were left behind in the markup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKS, LANGUAGES, DEFAULT_LANG, t, setLang, langNameInEnglish } from '../public/i18n.js';
import { BOOKS as SERVER, say, langFromHeader } from '../src/say.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('the two books say the same things');
{
  const en = Object.keys(BOOKS.en).sort();
  const ja = Object.keys(BOOKS.ja).sort();

  const missingFromJa = en.filter((k) => !(k in BOOKS.ja));
  const missingFromEn = ja.filter((k) => !(k in BOOKS.en));
  check('every English key has a Japanese one', missingFromJa.length === 0, missingFromJa.join(', '));
  check('every Japanese key has an English one', missingFromEn.length === 0, missingFromEn.join(', '));

  const empty = en.filter((k) => !String(BOOKS.en[k]).trim() || !String(BOOKS.ja[k] || '').trim());
  check('nothing is blank', empty.length === 0, empty.join(', '));

  // A sentence that takes a name must take the same names in both languages,
  // or one of them renders `{n}` at the reader.
  const slots = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  const mismatched = en.filter((k) => slots(BOOKS.en[k]) !== slots(BOOKS.ja[k]));
  check('the blanks to fill in match', mismatched.length === 0,
    mismatched.map((k) => `${k}: ${slots(BOOKS.en[k])} vs ${slots(BOOKS.ja[k])}`).join(' | '));
}

console.log('and so do the few sentences the server has to write itself');
{
  const en = Object.keys(SERVER.en);
  const ja = Object.keys(SERVER.ja);
  check('every English key has a Japanese one', en.every((k) => k in SERVER.ja),
    en.filter((k) => !(k in SERVER.ja)).join(', '));
  check('every Japanese key has an English one', ja.every((k) => k in SERVER.en),
    ja.filter((k) => !(k in SERVER.en)).join(', '));

  const slots = (v) => (String(v).match(/\{(\w+)\}/g) || []).sort().join(',');
  const bad = en.filter((k) => slots(SERVER.en[k]) !== slots(SERVER.ja[k]));
  check('the blanks to fill in match', bad.length === 0, bad.join(', '));

  check('an unknown language falls back to English',
    say('xx', 'login.wrong') === SERVER.en['login.wrong']);
  check('a browser asking for Japanese gets it', langFromHeader('ja-JP,ja;q=0.9,en;q=0.8') === 'ja');
  check('a browser asking for something else gets English',
    langFromHeader('fr-FR,fr;q=0.9') === 'en');
  check('no header at all is English', langFromHeader(undefined) === 'en');
}

console.log('English is what an unset board speaks');
{
  check('the default is English', DEFAULT_LANG === 'en');
  setLang('en');
  check('an unknown code falls back to English', setLang('xx') === 'en');
  check('both languages are offered', LANGUAGES.length === 2
    && LANGUAGES.some((l) => l.code === 'en') && LANGUAGES.some((l) => l.code === 'ja'));
}

console.log('filling in the blanks');
{
  setLang('en');
  check('a name is substituted', t('board.remaining', { time: '3:20' }) === '3:20 left');
  setLang('ja');
  check('and in Japanese too', t('board.remaining', { time: '3:20' }) === '残り 3:20');
  check('a missing key shows itself', t('nothing.like.this') === 'nothing.like.this');
  check('a missing value is left alone', t('board.remaining').includes('{time}'));
}

console.log('the closing line of the instructions names the language in English');
{
  check('English', langNameInEnglish('en') === 'English');
  check('Japanese', langNameInEnglish('ja') === 'Japanese');
}

console.log('nothing readable was left behind in the page');
{
  const html = read('public/index.html');

  // Any Japanese still sitting in the markup is a sentence that will not switch.
  // Attribute values that are keys are fine; this looks at text between tags
  // and at placeholder/title/aria-label attributes.
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '');

  const leftovers = [];
  const text = /(>)([^<>]*[ぁ-んァ-ヶ一-龠][^<>]*)(<)/g;
  let m;
  while ((m = text.exec(stripped))) {
    const line = m[2].trim();
    if (line) leftovers.push(line.slice(0, 40));
  }
  check('no Japanese sentences between the tags', leftovers.length === 0, leftovers.join(' | '));

  const attrs = [];
  const attr = /(placeholder|title|aria-label|content)="([^"]*[ぁ-んァ-ヶ一-龠][^"]*)"/g;
  while ((m = attr.exec(stripped))) attrs.push(`${m[1]}="${m[2].slice(0, 30)}"`);
  check('no Japanese left in attributes', attrs.length === 0, attrs.join(' | '));
}

console.log('and none left behind in the screens it draws');
{
  const app = read('public/app.js');
  const withoutComments = app
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const leftovers = [];
  // Japanese inside a quoted string is a sentence the reader will see.
  const quoted = /(['"`])((?:(?!\1)[^\\]|\\.)*[ぁ-んァ-ヶ一-龠](?:(?!\1)[^\\]|\\.)*)\1/g;
  let m;
  while ((m = quoted.exec(withoutComments))) leftovers.push(m[2].slice(0, 36));
  check('no Japanese strings in app.js', leftovers.length === 0, leftovers.join(' | '));
}

console.log('nor in what the server says back');
{
  // Three of these were found one at a time by eye, each time believing it was
  // the last one. The server's own sentences belong in say.js for the same
  // reason the screen's belong in i18n.js, so this counts them instead.
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const quoted = () => /(['"`])((?:(?!\1)[^\\]|\\.)*[ぁ-んァ-ヶ一-龠](?:(?!\1)[^\\]|\\.)*)\1/g;

  for (const file of ['src/server.js', 'src/account.js', 'src/push.js', 'src/http.js']) {
    const leftovers = [];
    const re = quoted();
    let m;
    const body = stripComments(read(file));
    while ((m = re.exec(body))) leftovers.push(m[2].slice(0, 36));
    check(`no Japanese strings in ${file}`, leftovers.length === 0, leftovers.join(' | '));
  }

  // board.js is the exception: it seeds a Japanese board on purpose, and that
  // block is data rather than a message. Only the sentences it hands back are
  // checked, which is where every one of the three was hiding.
  const board = stripComments(read('src/board.js'));
  const spoken = board.split('\n').filter((line) => /error:/.test(line) && /[ぁ-んァ-ヶ一-龠]/.test(line));
  check('no Japanese in what src/board.js hands back', spoken.length === 0,
    spoken.map((l) => l.trim().slice(0, 50)).join(' | '));
  check('but the Japanese seed is still there for a Japanese board',
    board.includes("first: '待機中'"));
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
