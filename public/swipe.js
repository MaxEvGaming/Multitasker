// Which page a sideways swipe on the board lands on.
//
// The pages go round (Owner 2026-10-06): a swipe on to "next" from the last
// page arrives at the first, and a swipe back from the first arrives at the
// last. A board with a single page has nowhere to go, so the swipe springs back
// as it always did.
//
// Kept apart from the page so the rule can be checked on its own, without a
// browser.
//
//   from   — the index of the page in view (-1 if it is not among the pages)
//   offset — +1 for a swipe to the next page, -1 for the previous one
//   count  — how many pages there are
//
// Returns the index to go to, or -1 when the swipe should go nowhere.
export function pageAfterSwipe(from, offset, count) {
  if (count <= 1 || from < 0 || from >= count) return -1;
  return (((from + offset) % count) + count) % count;
}
