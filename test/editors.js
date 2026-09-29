// The settings screen builds one row per state, per page and per square, and
// each row is built by its own function taking its own thing. The three look
// alike, so a block written for one gets pasted into another — and the paste
// carries a reference to a parameter the receiving function does not have.
//
// That happened, to two of the three. The row that threw took the whole of
// renderSettings down with it, so the states, the pages and the squares all
// vanished from the screen at once and none of them could be renamed. The board
// was unusable and every test still passed, because nothing here had ever run
// the settings screen.
//
// This reads the file and checks that no function mentions another one's
// parameter. It is not a substitute for opening the page, but it catches this
// exact paste, which is the one that keeps happening.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Comments and strings are full of ordinary prose — "an empty page." and the
// like — and a name inside one of those is not a use of anything.
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// Every top-level function, with the text of its body.
function functions(text) {
  const found = [];
  const re = /^(?:async )?function ([A-Za-z0-9_]+)\(([^)]*)\)\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    found.push({
      name: m[1],
      params: m[2].split(',').map((p) => p.trim().split(/[\s=]/)[0]).filter(Boolean),
      body: codeOnly(text.slice(m.index + m[0].length, i)),
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

const all = functions(source);
console.log('the settings rows are built by functions that each take their own thing');
check('the file parsed into functions', all.length > 20, `${all.length} found`);

// The parameter names that tell one kind of row from another. A body that
// mentions one of these without taking it is holding someone else's code.
const OWNED = ['task', 'page', 'st'];
const word = (name, after) => new RegExp(`\\b${name}\\b${after}`);

for (const fn of all) {
  const borrowed = OWNED.filter((name) => {
    if (fn.params.includes(name)) return false;
    // Declared inside, or handed to an inner callback, counts as owning it.
    if (word(name, '\\s*(?:=[^=]|,|\\)\\s*=>|=>)').test(fn.body)) return false;
    if (new RegExp(`(?:const|let|var|function|catch)\\s*\\(?\\s*\\b${name}\\b`).test(fn.body)) return false;
    if (new RegExp(`\\(\\s*\\b${name}\\b\\s*[,)]`).test(fn.body)) return false;
    return word(name, '\\.').test(fn.body);
  });
  if (borrowed.length) {
    check(`${fn.name} (line ${fn.line}) uses only what it was given`, false,
      `reaches for ${borrowed.join(', ')}`);
  }
}
if (failures === 0) console.log('  ok   no function reaches for another one’s parameter');

// Saving one row must not redraw the list that row is in.
//
// It did, and two things broke at once: every other row was rebuilt from the
// board, throwing away anything typed into them and not yet saved, and the
// "Saved" message was written to the row that had just been replaced, so nobody
// ever saw it. The owner reported both in one sentence.
console.log('saving a row leaves the rest of the list alone');
for (const [fn, ownRenderer] of [
  ['stateEditor', 'renderStates'],
  ['pageEditor', 'renderPages'],
  ['slotEditor', 'renderSlots'],
]) {
  const found = all.find((f) => f.name === fn);
  if (!found) { check(`${fn} is there to check`, false); continue; }
  // The save handler only — removing a row or moving it does change the list,
  // and redrawing is right there.
  const at = found.body.indexOf('save.addEventListener');
  const ends = found.body.indexOf('const remove', at);
  const handler = found.body.slice(at, ends > at ? ends : undefined);
  check(`${fn} does not call ${ownRenderer} when saving`,
    at >= 0 && !handler.includes(`${ownRenderer}(`),
    `it calls ${ownRenderer} and then flashes at a row that no longer exists`);
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
