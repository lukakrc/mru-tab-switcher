import { DEBUG, log, errMsg } from './log.js';

// windowId -> {
//   tabInfos: [{ id, title, favIconUrl, thumbnail }],  frozen for the cycle
//   index:       highlighted position within tabInfos
//   overlayTabId: tab hosting the overlay
//   touchedAt:   last activity, for staleness
// }
//
// A cycle only ever exists while an overlay is on screen, or for the moment
// just before one appears on the tab a browser-page press switches to — see
// continueOnTarget in background.js.
const cycleState = new Map();

// windowId -> setTimeout id. The overlay watches for the real DOM keyup, so it
// decides when the hold ends; this timer is only a backstop against a keyup
// that never arrives leaving the panel stuck on screen. It must stay long — a
// short one force-ends the cycle while the user is still holding the modifier
// and simply reading the switcher, which is not a timeout, it's a user
// thinking. Expiry never switches tabs.
const expiryTimers = new Map();
const CYCLE_EXPIRY_MS = 30000;

// When the page reports it doesn't have focus (the user was in the omnibox, or
// another app), no keyup can ever reach any frame, so the cycle has no natural
// end and the long deadline would strand the panel on screen. Fall back to a
// short one — the panel is still fully usable by mouse in the meantime.
const UNFOCUSED_EXPIRY_MS = 4000;

export function getCycle(windowId) {
  return cycleState.get(windowId);
}

// Thumbnail capture asks this before doing anything: a cycle in progress owns
// the worker's single thread, and responding to the shortcut is the job.
export function isCycleRunning() {
  return cycleState.size > 0;
}

/* ------------------------------------------------------------------ *
 * Overlay messaging
 * ------------------------------------------------------------------ */

// Guards against a null overlayTabId, which chrome.tabs.sendMessage would throw
// on, so callers never have to check.
function notifyOverlay(state, message) {
  if (state.overlayTabId == null) return;
  chrome.tabs.sendMessage(state.overlayTabId, message).catch(() => {});
}

export async function advanceCycle(windowId, state) {
  state.index = (state.index + 1) % state.tabInfos.length;
  try {
    await chrome.tabs.sendMessage(state.overlayTabId, { type: 'update', index: state.index });
  } catch (e) {
    return false;
  }
  state.touchedAt = Date.now();
  return true;
}

export async function tryShowOverlay(tabId, tabInfos, index, extra = {}) {
  // debug rides along so the single DEBUG flag also turns on the overlay's
  // logging, which lands in the page console rather than this one.
  const message = { type: 'show', tabs: tabInfos, index, debug: DEBUG, ...extra };

  // overlay.js is declared as a content script, so on any page loaded since the
  // extension started it is already resident and one message paints the panel.
  // That keeps the common path to a single round-trip.
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    log('overlay: resident content script replied', { tabId, res });
    if (res && res.ok && res.painted) return res;
    log('overlay: resident script did NOT paint, re-injecting', { tabId, res });
    // Fall through to injection: a listener answered but no panel exists, which
    // is what an orphaned/stale content script looks like.
  } catch (e) {
    // Not resident: the tab predates the extension being installed or reloaded,
    // so fall back to injecting it on demand.
    log('overlay: sendMessage failed, will inject', { tabId, error: errMsg(e) });
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch (e) {
    log('overlay: executeScript FAILED', { tabId, error: errMsg(e) });
    return null; // restricted page — no content script can ever run here
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    log('overlay: injected and replied', { tabId, res });
    return res && res.ok && res.painted ? res : null;
  } catch (e) {
    // Injection succeeded but nothing is listening — the classic symptom of an
    // orphaned content script whose load guard blocks re-registration.
    log('overlay: injected but NO LISTENER', { tabId, error: errMsg(e) });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Lifetime
 * ------------------------------------------------------------------ */

// Every write to cycleState goes through here so `touchedAt` can never be
// forgotten — staleness is what actually ends a cycle, so an unstamped state
// would be an immortal one.
export function setCycleState(windowId, state) {
  cycleState.set(windowId, { ...state, touchedAt: Date.now() });
  armExpiry(windowId);
}

// MV3 service workers are suspended between events, and pending setTimeout
// callbacks are dropped when that happens — a timer is best-effort, never a
// guarantee. Correctness therefore hangs off this check at command time rather
// than off armExpiry: state whose timer never fired would otherwise survive
// indefinitely and swallow every later press.
function expiryFor(state) {
  return state.focused === false ? UNFOCUSED_EXPIRY_MS : CYCLE_EXPIRY_MS;
}

export function isStale(state) {
  return Date.now() - state.touchedAt > expiryFor(state);
}

// Forget the cycle without telling the overlay. For when there is nothing left
// to tell: the tab hosting the panel is gone, its window closed, or a failed
// advance already proved the overlay unreachable.
export function endCycle(windowId) {
  cycleState.delete(windowId);
  clearExpiry(windowId);
}

// The usual ending: take the panel off screen, then forget the cycle. Safe to
// call for a window with no cycle.
export function closeCycle(windowId) {
  const state = cycleState.get(windowId);
  if (state) notifyOverlay(state, { type: 'teardown' });
  endCycle(windowId);
}

export function armExpiry(windowId) {
  clearExpiry(windowId);
  const state = cycleState.get(windowId);
  if (!state) return;
  expiryTimers.set(windowId, setTimeout(() => expireCycle(windowId), expiryFor(state)));
}

function clearExpiry(windowId) {
  const timeoutId = expiryTimers.get(windowId);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    expiryTimers.delete(windowId);
  }
}

// Deliberately does NOT switch tabs. Timing out means we lost track of the
// hold, not that the user chose the highlighted tab — yanking them somewhere
// they never confirmed is far worse than making them press the shortcut again.
function expireCycle(windowId) {
  closeCycle(windowId);
}

// A tab closing mid-cycle. Its card has to go, and if that leaves too few to
// switch between, so does the whole panel.
export function removeTabFromCycles(tabId) {
  for (const [windowId, state] of cycleState) {
    if (state.overlayTabId === tabId) {
      // The panel went with the tab; there is no one left to notify.
      endCycle(windowId);
      continue;
    }
    const idx = state.tabInfos.findIndex((t) => t.id === tabId);
    if (idx === -1) continue;

    state.tabInfos.splice(idx, 1);
    if (state.tabInfos.length < 2) {
      closeCycle(windowId);
      continue;
    }
    if (state.index >= state.tabInfos.length) state.index = 0;
    // Rebuild rather than just re-highlighting: a card was removed, so the
    // overlay's own copy of the list is now stale and its indices no longer
    // line up with ours.
    notifyOverlay(state, { type: 'show', tabs: state.tabInfos, index: state.index });
  }
}
