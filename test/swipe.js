// Swiping between pages goes round (Owner 2026-10-06): on from the last page is
// the first, back from the first is the last. One page goes nowhere. Checked
// here rather than in a browser, on the rule the board uses (public/swipe.js).
import { pageAfterSwipe } from '../public/swipe.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const is = (label, got, want) => check(label, got === want, `got ${got}, want ${want}`);

const NEXT = 1;
const PREV = -1;

console.log('three pages go round');
is('next from the last is the first', pageAfterSwipe(2, NEXT, 3), 0);
is('back from the first is the last', pageAfterSwipe(0, PREV, 3), 2);
is('next from the first is the second', pageAfterSwipe(0, NEXT, 3), 1);
is('next from the middle is the last', pageAfterSwipe(1, NEXT, 3), 2);
is('back from the middle is the first', pageAfterSwipe(1, PREV, 3), 0);
is('back from the last is the middle', pageAfterSwipe(2, PREV, 3), 1);

console.log('one page goes nowhere');
is('next', pageAfterSwipe(0, NEXT, 1), -1);
is('back', pageAfterSwipe(0, PREV, 1), -1);

console.log('two pages: either way is the other one');
is('next from the first', pageAfterSwipe(0, NEXT, 2), 1);
is('back from the first', pageAfterSwipe(0, PREV, 2), 1);
is('next from the second', pageAfterSwipe(1, NEXT, 2), 0);
is('back from the second', pageAfterSwipe(1, PREV, 2), 0);

console.log('a page not among the pages goes nowhere');
is('not found', pageAfterSwipe(-1, NEXT, 3), -1);

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
