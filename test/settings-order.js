// The settings sections rearrange themselves as setup progresses. All the
// combinations are checked here rather than in the browser, because the branch
// where notifications are working cannot be reached in a headless one — it
// refuses the permission outright, so the interesting half would never run.
import { settingsOrder } from '../public/settings-order.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const show = (order) => order.map((id) => id.replace('sec-', '')).join(' → ');
const after = (order, a, b) => order.indexOf(a) === order.indexOf(b) - 1;
const every = (extra) => ({ pushDone: false, hookDone: false, langSeen: false, ...extra });

console.log('language leads until this screen has been seen');
{
  for (const pushDone of [false, true]) {
    for (const hookDone of [false, true]) {
      const order = settingsOrder(every({ pushDone, hookDone }));
      check(`first (push=${pushDone}, hook=${hookDone})`, order[0] === 'sec-lang', show(order));
    }
  }
}

console.log('and then sits just above the account, whether or not it was changed');
{
  for (const pushDone of [false, true]) {
    for (const hookDone of [false, true]) {
      const order = settingsOrder(every({ pushDone, hookDone, langSeen: true }));
      check(`above the account (push=${pushDone}, hook=${hookDone})`,
        after(order, 'sec-lang', 'sec-account'), show(order));
      check(`no longer first (push=${pushDone}, hook=${hookDone})`,
        order[0] !== 'sec-lang', show(order));
    }
  }
}

console.log('the request for donations is at the top, except under the unseen language');
{
  for (const pushDone of [false, true]) {
    for (const hookDone of [false, true]) {
      const unseen = settingsOrder(every({ pushDone, hookDone }));
      check(`second, under the language, until it is seen (push=${pushDone}, hook=${hookDone})`,
        unseen[0] === 'sec-lang' && unseen[1] === 'sec-donate', show(unseen));
      const seen = settingsOrder(every({ pushDone, hookDone, langSeen: true }));
      check(`first once the language has been seen (push=${pushDone}, hook=${hookDone})`,
        seen[0] === 'sec-donate', show(seen));
    }
  }
}

console.log('nothing set up yet');
{
  const order = settingsOrder(every({}));
  check('notifications come first of the setup steps', order[2] === 'sec-push', show(order));
  check('the inlet comes next', order[3] === 'sec-hook', show(order));
  check('the terms and the contact line stay last (T-096)', order[order.length - 1] === 'sec-legal', show(order));
  check('with the diary just above them', after(order, 'sec-diary', 'sec-legal'), show(order));
  check('and what is kept here above that', after(order, 'sec-data', 'sec-diary'), show(order));
}

console.log('a report has arrived, but this device cannot be notified yet');
{
  const order = settingsOrder(every({ hookDone: true }));
  check('notifications still lead the setup steps', order[2] === 'sec-push', show(order));
  check('the inlet sits directly beneath it', after(order, 'sec-push', 'sec-hook'), show(order));
}

console.log('notifications work, but nothing has come through the inlet');
{
  const order = settingsOrder(every({ pushDone: true }));
  check('the inlet is the one still asking for attention', order[2] === 'sec-hook', show(order));
  // The PC sits under the states (it is part of the board's own settings), so
  // "below the cycle settings" means below it.
  check('notifications have sunk below the cycle settings',
    after(order, 'sec-pc', 'sec-push'), show(order));
}

console.log('both are working, and the language has been seen');
{
  const order = settingsOrder({ pushDone: true, hookDone: true, langSeen: true });
  check('the everyday settings are on top, under the request for donations',
    order.slice(0, 4).join() === 'sec-donate,sec-slots,sec-pages,sec-states', show(order));
  check('notifications sit under the cycle settings',
    after(order, 'sec-pc', 'sec-push'), show(order));
  check('the inlet sits under notifications', after(order, 'sec-push', 'sec-hook'), show(order));
  check('then language, then the account',
    after(order, 'sec-hook', 'sec-lang') && after(order, 'sec-lang', 'sec-account'), show(order));
}

console.log('nothing is ever dropped');
{
  const all = ['sec-donate', 'sec-lang', 'sec-push', 'sec-hook', 'sec-pages', 'sec-slots', 'sec-states', 'sec-pc', 'sec-account', 'sec-data', 'sec-diary', 'sec-legal'];
  for (const pushDone of [false, true]) {
    for (const hookDone of [false, true]) {
      for (const langSeen of [false, true]) {
        const order = settingsOrder({ pushDone, hookDone, langSeen });
        const same = order.length === all.length && all.every((id) => order.includes(id));
        check(`all twelve present (push=${pushDone}, hook=${hookDone}, seen=${langSeen})`,
          same, show(order));
      }
    }
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
