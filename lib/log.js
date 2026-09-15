// Flip to true to trace cycle decisions in the service worker console
// (chrome://extensions -> "service worker" under this extension).
export const DEBUG = true;

export function log(...args) {
  if (DEBUG) console.log('[mru]', ...args);
}

// Nearly every catch in this extension is the same shape: the browser took
// something away mid-call (a closed tab, a torn-down worker, a rate limit), we
// log a line and carry on. None of those have a stack worth keeping, so the
// message is the whole story. Falls back to the thrown value itself, since not
// everything Chrome rejects with is an Error.
export function errMsg(e) {
  return String((e && e.message) || e);
}
