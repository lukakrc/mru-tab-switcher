import { log, errMsg } from './log.js';
import { once } from './async.js';

export const MAX_TABS = 12;

// windowId -> array of tabIds, most-recently-used first
const mruByWindow = new Map();

// Seeding from scratch is the only moment we know which tab each window is
// sitting on before a single event has fired, which makes it the natural place
// to grab a first thumbnail. Tracking the MRU order has no business knowing
// what a thumbnail is, though, so the capture is injected rather than imported
// — that is also what keeps this module free of a cycle with thumbnails.js.
let onSeed = () => {};

export function setSeedHandler(fn) {
  onSeed = fn;
}

// The window's switchable tabs, newest first and capped at what a cycle can
// show. Callers get a copy, so the live list can't be mutated from outside.
export function mruIds(windowId) {
  return (mruByWindow.get(windowId) || []).slice(0, MAX_TABS);
}

// Never rejects. Every caller is fire-and-forget, so a rejection here surfaces
// as an unhandled promise rejection — and Chrome throws "No SW" from any
// extension API call that lands while the worker is being torn down, which is
// entirely routine in MV3.
async function persistMru() {
  const plain = {};
  for (const [windowId, ids] of mruByWindow) plain[windowId] = ids;
  try {
    await chrome.storage.session.set({ mruByWindow: plain });
  } catch (e) {
    log('persistMru failed', { error: errMsg(e) });
  }
}

// The one way any tab enters or moves within a window's list: drop any existing
// entry, then splice the tab back in at `position`. Position 0 is the tab you
// are on, so 1 is the first thing the switcher offers.
function insertAt(windowId, tabId, position) {
  const list = (mruByWindow.get(windowId) || []).filter((id) => id !== tabId);
  list.splice(position, 0, tabId);
  mruByWindow.set(windowId, list);
  persistMru();
}

export function touchTab(windowId, tabId) {
  insertAt(windowId, tabId, 0);
}

// Slot a tab in at index 1, the first position the switcher offers. Used for
// tabs opened in the background, which have never been active and so would
// otherwise never enter the list at all — cmd-clicking a link and immediately
// reaching for the switcher is exactly when you want that tab, and it was the
// one tab you could not reach.
export function insertAsNextTarget(windowId, tabId) {
  insertAt(windowId, tabId, 1);
}

// Dragging a tab between windows, or closing it, leaves its id behind in the
// list, where it resolves to nothing and is silently skipped. Enough of those
// and the list falls below the two entries a cycle needs, so the shortcut does
// nothing at all — which is indistinguishable from a dropped press.
export function removeTab(windowId, tabId) {
  const list = mruByWindow.get(windowId);
  if (!list) return;
  mruByWindow.set(windowId, list.filter((id) => id !== tabId));
  persistMru();
}

export function forgetWindow(windowId) {
  mruByWindow.delete(windowId);
  persistMru();
}

async function restoreMru() {
  let stored;
  try {
    ({ mruByWindow: stored } = await chrome.storage.session.get('mruByWindow'));
  } catch (e) {
    log('restoreMru failed', { error: errMsg(e) });
    return;
  }
  if (stored) {
    for (const [windowId, ids] of Object.entries(stored)) {
      mruByWindow.set(Number(windowId), ids);
    }
    return;
  }
  // First run / no session data: seed from current tabs.
  let windows;
  try {
    windows = await chrome.windows.getAll({ populate: true });
  } catch (e) {
    log('restoreMru seed failed', { error: errMsg(e) });
    return;
  }
  for (const win of windows) {
    const tabs = [...win.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    mruByWindow.set(win.id, tabs.map((t) => t.id));
    const activeTab = win.tabs.find((t) => t.active);
    if (activeTab) onSeed(win.id, activeTab.id);
  }
  await persistMru();
}

export const ensureMru = once(restoreMru, 'restoreMru');
