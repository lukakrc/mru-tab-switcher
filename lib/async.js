import { log, errMsg } from './log.js';

// Memoises a one-shot rebuild of in-memory state after a worker wake, so the
// callers that need that state can each await it without it running more than
// once. Split per concern rather than one big init: a command needs the MRU
// order and nothing else, and making it wait on the thumbnail index too put
// unrelated work in front of every keypress.
//
// Holding the promise in a variable is also a trap worth naming: created once
// per worker, a single rejection — "No SW" from a call landing during teardown —
// leaves every later await throwing instantly, and enqueueCommand swallows it,
// so the press silently does nothing. Clearing the handle on failure means the
// next caller retries instead of inheriting a poisoned promise.
export function once(fn, label) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = fn().catch((e) => {
        log(`${label} failed, will retry`, { error: errMsg(e) });
        promise = null;
      });
    }
    return promise;
  };
}

// Resolves to undefined if `promise` outruns `ms`, leaving it to settle on its
// own. Used to keep one slow step from stalling a strictly serial queue.
export function withTimeout(promise, ms, label) {
  let timer;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => {
      log('timed out; letting the queue advance', { label, ms });
      resolve(undefined);
    }, ms);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Both thumbnail maps are LRU queues: delete-then-set moves an entry to the
// newest end, so the oldest is always the first key and eviction pops the front.
export function trimLru(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}
