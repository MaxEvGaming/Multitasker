// Where each settings section sits, given how far setup has got.
//
// The two setup sections start at the top, where they cannot be missed, and
// sink below the everyday settings once they have done their job. Nothing is
// ever hidden: a thing that is set up still has to be reachable to change.
//
// Kept apart from the page so the rule can be checked on its own — the branch
// where notifications are working cannot be reached in a headless browser,
// which refuses the permission outright.
export function settingsOrder({ pushDone, hookDone, langSeen }) {
  const upper = [];
  const lower = [];

  (pushDone ? lower : upper).push('sec-push');

  // The inlet follows the notification section wherever it has gone, but only
  // once something has actually arrived through it; until then it stays up top
  // next to the other thing still needing attention.
  if (hookDone) {
    const target = pushDone ? lower : upper;
    target.splice(target.indexOf('sec-push') + 1, 0, 'sec-hook');
  } else {
    upper.push('sec-hook');
  }

  // Language leads, above even the setup sections: someone who cannot read the
  // screen cannot follow the instructions on it. But only until it has been
  // seen. Having reached this screen once, the choice has been offered — taking
  // it or leaving it are both answers — so it sinks to just above the account,
  // among the other settings that are changed rarely and never urgently.
  // The PC sits with the board's own settings, under the states its command
  // squares move between: it is a thing the squares point at, not a setup
  // step everyone has — a board with no command squares never needs it.
  const rest = [...upper, 'sec-slots', 'sec-pages', 'sec-states', 'sec-pc', ...lower];
  // What is kept here sits with the account: both are about the person rather
  // than about the board, and both are read once and then left alone.
  // The request for donations stays at the top of the panel (T-072). The one
  // thing allowed above it is the language, and only until it has been seen:
  // someone who cannot read the screen has to be able to fix that before
  // reading anything else on it (T-091).
  // The terms, the privacy policy and where to reach the operator close the
  // panel, the same line the sign-in screen shows (T-096): last, always.
  return langSeen
    ? ['sec-donate', ...rest, 'sec-lang', 'sec-account', 'sec-data', 'sec-diary', 'sec-legal']
    : ['sec-lang', 'sec-donate', ...rest, 'sec-account', 'sec-data', 'sec-diary', 'sec-legal'];
}
