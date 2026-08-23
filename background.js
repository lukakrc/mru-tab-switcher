// Flip to true to trace cycle decisions in the service worker console
// (chrome://extensions -> "service worker" under this extension).
const DEBUG = false;
function log(...args) {
  if (DEBUG) console.log('[mru]', ...args);
}

const MAX_TABS = 12;

// windowId -> array of tabIds, most-recently-used first
const mruByWindow = new Map();

// url -> jpeg data URL, the most recent screenshot captured of that page.
// Insertion order is kept meaningful (re-capturing deletes before setting) so
// the oldest entry is always the first one, making the Map an LRU queue.
//
// Keyed by URL rather than tab id, and mirrored into chrome.storage.local
// rather than .session, so a preview outlives both the tab and the browser
// session: a restored tab shows its previous thumbnail immediately, and so does
// a brand-new tab pointing at a page seen before. Tab ids would be useless for
// that — Chrome reassigns them on restart.
//
// Note this writes page screenshots to disk. Only http(s) pages are cached, but
// a screenshot is whatever was on the page, signed-in content included.
// Downscaling is also what keeps it affordable: the card renders at 190px, so
// nothing beyond THUMB_WIDTH_PX of detail is worth keeping.
const thumbnailsByUrl = new Map();
const THUMB_PREFIX = 'thumb:';
// The card renders 190px wide, so 400 covers a 2x display with nothing spare.
// These three are the size knobs: width dominates, quality is the fine tune.
const THUMB_WIDTH_PX = 400;
const THUMB_MIME = 'image/webp';
const THUMB_QUALITY = 0.6;
const MAX_STORED_THUMBNAILS = 60;

async function init() {
  await Promise.all([restoreMru(), restoreThumbnails()]);
}

// Runs on every worker wake, not just install/startup — the worker is torn down
// whenever it goes idle, and both maps have to be rebuilt before the first
// command is served. Commands await this so a press arriving during the wake
// doesn't read an empty MRU list and abort.
const ready = init();

// windowId -> {
//   tabInfos: [{ id, title, favIconUrl, thumbnail }],  frozen for the cycle
//   index:       highlighted position within tabInfos
//   overlayTabId: tab hosting the overlay
//   touchedAt:   last activity, for staleness
// }
//
// A cycle only ever exists while an overlay is on screen. Restricted pages
// (chrome://*, the Web Store) take a stateless path instead — see quickSwitch.
const cycleState = new Map();

// windowId -> tail of an in-order promise chain for that window's commands.
const commandQueues = new Map();

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

/* ------------------------------------------------------------------ *
 * MRU tracking
 * ------------------------------------------------------------------ */

async function persistMru() {
  const plain = {};
  for (const [windowId, ids] of mruByWindow) plain[windowId] = ids;
  await chrome.storage.session.set({ mruByWindow: plain });
}

async function restoreMru() {
  const { mruByWindow: stored } = await chrome.storage.session.get('mruByWindow');
  if (stored) {
    for (const [windowId, ids] of Object.entries(stored)) {
      mruByWindow.set(Number(windowId), ids);
    }
    return;
  }
  // First run / no session data: seed from current tabs.
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    const tabs = [...win.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    mruByWindow.set(win.id, tabs.map((t) => t.id));
    const activeTab = win.tabs.find((t) => t.active);
    if (activeTab) captureThumbnail(win.id, activeTab.id);
  }
  await persistMru();
}

function touchTab(windowId, tabId) {
  const list = mruByWindow.get(windowId) || [];
  const next = [tabId, ...list.filter((id) => id !== tabId)];
  mruByWindow.set(windowId, next);
  persistMru();
}

function faviconUrlFor(pageUrl) {
  // tab.favIconUrl is empty for chrome:// pages; this API resolves an icon for
  // any URL, internal pages included.
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

// Shrink a full-resolution capture to roughly what the card actually displays.
// OffscreenCanvas and createImageBitmap are available in service workers;
// FileReader is not, hence the manual base64 step.
async function downscale(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_WIDTH_PX / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // WebP runs 25-35% smaller than JPEG at matching quality, and only Chrome has
  // to decode this. convertToBlob silently falls back to PNG when asked for a
  // type it cannot encode, and a PNG screenshot is far larger than the JPEG we
  // started from — so check what actually came back rather than assuming.
  let out = await canvas.convertToBlob({ type: THUMB_MIME, quality: THUMB_QUALITY });
  if (out.type !== THUMB_MIME) {
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
  }

  const bytes = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  log('thumbnail encoded', { type: out.type, kb: Math.round(bytes.length / 102.4) / 10 });
  return `data:${out.type};base64,` + btoa(binary);
}

// captureVisibleTab is rate-limited by Chrome, and the events that trigger a
// capture can arrive in bursts (a redirect chain fires several 'complete'
// updates). Skipping captures closer together than this costs nothing — the
// frames would be near-identical anyway.
const MIN_CAPTURE_INTERVAL_MS = 500;
const lastCaptureAt = new Map();

async function captureThumbnail(windowId, tabId) {
  const now = Date.now();
  if (now - (lastCaptureAt.get(tabId) || 0) < MIN_CAPTURE_INTERVAL_MS) return;
  lastCaptureAt.set(tabId, now);

  let url;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch (e) {
    return; // tab vanished
  }
  if (!url || !/^https?:/.test(url)) return; // nothing worth caching

  let thumbnail;
  try {
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
    thumbnail = await downscale(raw);
  } catch (e) {
    // Restricted page, rate-limited, or window not focused — keep any existing
    // thumbnail rather than blanking the card.
    return;
  }

  thumbnailsByUrl.delete(url); // re-insert so this becomes the newest entry
  thumbnailsByUrl.set(url, thumbnail);

  const writes = { [THUMB_PREFIX + url]: { d: thumbnail, at: now } };
  const evicted = [];
  while (thumbnailsByUrl.size > MAX_STORED_THUMBNAILS) {
    const oldest = thumbnailsByUrl.keys().next().value;
    thumbnailsByUrl.delete(oldest);
    evicted.push(THUMB_PREFIX + oldest);
  }

  try {
    await chrome.storage.local.set(writes);
    if (evicted.length) await chrome.storage.local.remove(evicted);
  } catch (e) {
    log('thumbnail persist failed', { url, error: String(e && e.message) });
  }
}

async function restoreThumbnails() {
  let stored;
  try {
    stored = await chrome.storage.local.get(null);
  } catch (e) {
    return;
  }

  // Rebuild in least-recently-captured order so the Map's insertion order stays
  // a valid LRU queue across restarts — eviction pops from the front.
  const entries = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(THUMB_PREFIX) || !value || !value.d) continue;
    entries.push({ url: key.slice(THUMB_PREFIX.length), data: value.d, at: value.at || 0 });
  }
  entries.sort((a, b) => a.at - b.at);

  const overflow = entries.splice(0, Math.max(0, entries.length - MAX_STORED_THUMBNAILS));
  for (const e of entries) thumbnailsByUrl.set(e.url, e.data);
  if (overflow.length) {
    chrome.storage.local.remove(overflow.map((e) => THUMB_PREFIX + e.url)).catch(() => {});
  }
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  touchTab(windowId, tabId);
  captureThumbnail(windowId, tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.active) touchTab(tab.windowId, tab.id);
});

// A tab you are sitting on can change without ever being re-activated, which
// used to leave a thumbnail showing the page you navigated away from.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) captureThumbnail(tab.windowId, tabId);
});

// Returning to Chrome from another app. captureVisibleTab fails while the
// window is unfocused, so this is the first moment a fresh frame is available
// again — and it is also when the service worker tends to wake back up.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) captureThumbnail(windowId, tab.id);
  } catch (e) {
    // window closed between the event and the query
  }
});

chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  // The thumbnail cache is keyed by URL and deliberately outlives the tab —
  // that is what lets a reopened page show a preview straight away.
  lastCaptureAt.delete(tabId);

  const list = mruByWindow.get(windowId);
  if (list) {
    mruByWindow.set(windowId, list.filter((id) => id !== tabId));
    persistMru();
  }

  for (const [wid, state] of cycleState) {
    if (state.overlayTabId === tabId) {
      endCycle(wid);
      continue;
    }
    const idx = state.tabInfos.findIndex((t) => t.id === tabId);
    if (idx === -1) continue;

    state.tabInfos.splice(idx, 1);
    if (state.tabInfos.length < 2) {
      notifyOverlay(state, { type: 'teardown' });
      endCycle(wid);
      continue;
    }
    if (state.index >= state.tabInfos.length) state.index = 0;
    // Rebuild rather than just re-highlighting: a card was removed, so the
    // overlay's own copy of the list is now stale and its indices no longer
    // line up with ours.
    notifyOverlay(state, { type: 'show', tabs: state.tabInfos, index: state.index });
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  mruByWindow.delete(windowId);
  commandQueues.delete(windowId);
  endCycle(windowId);
  persistMru();
});

/* ------------------------------------------------------------------ *
 * Cycle lifecycle
 * ------------------------------------------------------------------ */

async function startCycle(tab) {
  const windowId = tab.windowId;
  // Stamped before any await so it predates every hop between the keypress and
  // the panel appearing. The overlay reports when it last saw a modifier
  // release; if that is newer than this, the user let go while we were still
  // getting the panel up and there is no hold left to wait on.
  const startedAt = Date.now();
  const ids = (mruByWindow.get(windowId) || []).slice(0, MAX_TABS);

  // One query for the whole window rather than a chrome.tabs.get per entry.
  // Those awaits ran sequentially, so a full list cost a dozen round-trips
  // before anything could render — long enough that a quick tap-and-release
  // was already over by the time the overlay appeared, making it flash and
  // vanish. Everything before the first paint is on the critical path.
  const byId = new Map();
  const groupById = new Map();
  try {
    // Both in one parallel step — everything here is on the critical path
    // before the overlay can paint.
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId }),
      chrome.tabGroups.query({ windowId }).catch(() => []),
    ]);
    for (const t of tabs) byId.set(t.id, t);
    for (const g of groups) groupById.set(g.id, g);
  } catch (e) {
    return;
  }

  const tabInfos = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) continue; // tab no longer exists; skip
    // groupId is -1 (TAB_GROUP_ID_NONE) for ungrouped tabs.
    const group = t.groupId > -1 ? groupById.get(t.groupId) : null;
    tabInfos.push({
      id: t.id,
      title: t.title || t.url || 'Untitled',
      favIconUrl: faviconUrlFor(t.url) || t.favIconUrl || '',
      thumbnail: thumbnailsByUrl.get(t.url) || null,
      group: group ? { title: group.title || '', color: group.color } : null,
    });
  }

  log('startCycle', {
    activeTabId: tab.id,
    mruIds: ids.length,
    resolved: tabInfos.length,
    windowTabs: byId.size,
  });
  if (tabInfos.length < 2) {
    log('startCycle: ABORT, fewer than 2 resolvable tabs');
    return; // nothing to switch to
  }

  const startIndex = 1; // previously active tab

  const shown = await tryShowOverlay(tab.id, tabInfos, startIndex);
  if (shown) {
    // The release already happened — the panel went up after the hold ended, so
    // nothing further will arrive to close it. Finish the switch now instead of
    // leaving it on screen waiting for an event that is already in the past.
    if (shown.releasedAt && shown.releasedAt >= startedAt) {
      log('release predates paint; committing immediately', {
        startedAt,
        releasedAt: shown.releasedAt,
      });
      chrome.tabs.sendMessage(tab.id, { type: 'teardown' }).catch(() => {});
      const target = tabInfos[startIndex];
      if (target) chrome.tabs.update(target.id, { active: true }).catch(() => {});
      return;
    }

    setCycleState(windowId, {
      tabInfos,
      index: startIndex,
      overlayTabId: tab.id,
      focused: shown.focused !== false,
    });
    return;
  }

  // Restricted page: no overlay can ever render here, so there is nothing to
  // cycle within. Switch once and store NOTHING.
  await quickSwitch(windowId, tabInfos[startIndex]);
}

// Jump to one tab and record nothing at all.
//
// Chrome forbids content scripts on chrome:// pages and the Web Store, so the
// switcher UI simply cannot exist while one of them is in front. Earlier
// versions kept a "blind" cycle here so repeated taps could keep walking the
// list without UI. That state was the source of a long tail of bugs — once
// created it could survive in ways that stopped the overlay appearing on normal
// pages too, and it was never worth what it bought. Holding no state means
// there is nothing to leak into the next cycle: the next press, from a normal
// page, starts clean.
async function quickSwitch(windowId, target) {
  if (!target) return;
  log('quickSwitch (restricted page): stateless jump', { to: target.id });
  try {
    await chrome.tabs.update(target.id, { active: true });
  } catch (e) {
    // tab disappeared; nothing to clean up because nothing was stored
  }
}

async function advanceCycle(windowId, state) {
  state.index = (state.index + 1) % state.tabInfos.length;
  try {
    await chrome.tabs.sendMessage(state.overlayTabId, { type: 'update', index: state.index });
  } catch (e) {
    return false;
  }
  state.touchedAt = Date.now();
  return true;
}

async function tryShowOverlay(tabId, tabInfos, index) {
  // debug rides along so the single DEBUG flag also turns on the overlay's
  // logging, which lands in the page console rather than this one.
  const message = { type: 'show', tabs: tabInfos, index, debug: DEBUG };

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
    log('overlay: sendMessage failed, will inject', { tabId, error: String(e && e.message) });
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch (e) {
    log('overlay: executeScript FAILED', { tabId, error: String(e && e.message) });
    return null; // restricted page — no content script can ever run here
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    log('overlay: injected and replied', { tabId, res });
    return res && res.ok && res.painted ? res : null;
  } catch (e) {
    // Injection succeeded but nothing is listening — the classic symptom of an
    // orphaned content script whose load guard blocks re-registration.
    log('overlay: injected but NO LISTENER', { tabId, error: String(e && e.message) });
    return null;
  }
}

// Guards against a null overlayTabId, which chrome.tabs.sendMessage would throw
// on, so callers never have to check.
function notifyOverlay(state, message) {
  if (state.overlayTabId == null) return;
  chrome.tabs.sendMessage(state.overlayTabId, message).catch(() => {});
}

// Every write to cycleState goes through here so `touchedAt` can never be
// forgotten — staleness is what actually ends a cycle, so an unstamped state
// would be an immortal one.
function setCycleState(windowId, state) {
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

function isStale(state) {
  return Date.now() - state.touchedAt > expiryFor(state);
}

function endCycle(windowId) {
  cycleState.delete(windowId);
  clearExpiry(windowId);
}

function armExpiry(windowId) {
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
  const state = cycleState.get(windowId);
  if (!state) return;
  notifyOverlay(state, { type: 'teardown' });
  endCycle(windowId);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

// chrome.commands.onCommand fires once per keydown, and holding the modifier
// while tapping the key repeatedly triggers OS key-repeat fast enough that a
// new command can arrive before the previous one's async work (tab switches,
// script injection) has finished. Handling commands concurrently let two
// startCycle runs fight over the same window's active tab and cycle state.
// Queuing strictly serializes processing per window so that can't happen.
function enqueueCommand(windowId, task) {
  const previous = commandQueues.get(windowId) || Promise.resolve();
  const next = previous.then(task, task);
  commandQueues.set(windowId, next.catch(() => {}));
  return next;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'cycle-tabs' || !tab) return;
  const windowId = tab.windowId;

  enqueueCommand(windowId, async () => {
    await ready;
    let state = cycleState.get(windowId);

    // Never trust a timer to have ended the previous cycle.
    if (state && isStale(state)) {
      log('command: discarding stale cycle');
      notifyOverlay(state, { type: 'teardown' });
      endCycle(windowId);
      state = null;
    }

    log('command', {
      activeTabId: tab.id,
      url: (tab.url || '').slice(0, 60),
      hasState: !!state,
    });

    if (!state) {
      await startCycle(tab);
      return;
    }

    // A failed advance means the overlay is gone (navigated away, crashed) —
    // drop the stale cycle and start over from the current MRU order.
    if (await advanceCycle(windowId, state)) {
      armExpiry(windowId);
    } else {
      endCycle(windowId);
      await startCycle(tab);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const windowId = sender.tab && sender.tab.windowId;
  if (windowId === undefined) return;
  const state = cycleState.get(windowId);
  if (!state) return;

  if (msg.type === 'confirm-switch') {
    log('confirm-switch received', { fromFrameId: sender.frameId, index: msg.index });
    const index = typeof msg.index === 'number' ? msg.index : state.index;
    const target = state.tabInfos[index];
    // Broadcast the teardown rather than assuming the sender removed the panel.
    // A release caught in an iframe arrives here from a frame that has no panel
    // of its own, so the top frame would otherwise keep it on screen. Reaching
    // the sender too is harmless — it has already torn itself down.
    notifyOverlay(state, { type: 'teardown' });
    endCycle(windowId);
    if (target) chrome.tabs.update(target.id, { active: true }).catch(() => {});
  } else if (msg.type === 'cancel') {
    notifyOverlay(state, { type: 'teardown' });
    endCycle(windowId);
  }
});

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
