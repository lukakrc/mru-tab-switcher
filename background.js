import { log, errMsg } from './lib/log.js';
import { withTimeout } from './lib/async.js';
import { activateTab, displayTitle, faviconUrlFor } from './lib/tabs.js';
import {
  ensureMru,
  forgetWindow,
  insertAsNextTarget,
  mruIds,
  removeTab,
  setSeedHandler,
  touchTab,
} from './lib/mru.js';
import {
  captureThumbnail,
  ensureThumbIndex,
  forgetTabCaptureTime,
  indexedCount,
  loadThumbnails,
  thumbnailFor,
} from './lib/thumbnails.js';
import {
  advanceCycle,
  armExpiry,
  closeCycle,
  endCycle,
  getCycle,
  isStale,
  removeTabFromCycles,
  setCycleState,
  tryShowOverlay,
} from './lib/cycle.js';

// Unhandled rejections are the failure mode that hurts most here: MV3 throws
// "No SW" from any extension API that lands while the worker is being torn
// down, and a rejection that escapes into a promise the code later awaits can
// disable the extension silently rather than loudly. Surfacing them makes that
// visible the first time instead of after a week of "it feels laggy".
self.addEventListener('unhandledrejection', (event) => {
  console.warn('[mru] unhandled rejection:', event.reason);
});

// windowId -> tail of an in-order promise chain for that window's commands.
const commandQueues = new Map();

// Seeding the MRU from a cold start is the only place that knows each window's
// active tab before any event has fired, so it is where the first thumbnails
// come from. Wired here rather than imported inside mru.js, which has no
// business knowing thumbnails exist.
setSeedHandler((windowId, tabId) => {
  captureThumbnail(windowId, tabId).catch(() => {});
});

// Kick off on every worker wake, not just install/startup — the worker is torn
// down whenever it goes idle, and both caches have to be rebuilt before the
// first command is served. Commands await ensureMru so a press arriving during
// the wake doesn't read an empty MRU list and abort.
//
// The two halves are restored independently and awaited only by the code that
// needs them: a command needs the MRU order and nothing else, so making it wait
// on the thumbnail index too put unrelated work in front of every keypress.
async function init() {
  const startedAt = Date.now();
  await Promise.all([ensureMru(), ensureThumbIndex()]);
  log('init complete', { ms: Date.now() - startedAt, indexed: indexedCount() });
}

init();

/* ------------------------------------------------------------------ *
 * Tab and window events
 * ------------------------------------------------------------------ */

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  touchTab(windowId, tabId);
  captureThumbnail(windowId, tabId).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.active) touchTab(tab.windowId, tab.id);
  else insertAsNextTarget(tab.windowId, tab.id);
});

chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  removeTab(oldWindowId, tabId);
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  insertAsNextTarget(newWindowId, tabId);
});

// A tab you are sitting on can change without ever being re-activated, which
// used to leave a thumbnail showing the page you navigated away from.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    captureThumbnail(tab.windowId, tabId).catch(() => {});
  }
});

// Returning to Chrome from another app. captureVisibleTab fails while the
// window is unfocused, so this is the first moment a fresh frame is available
// again — and it is also when the service worker tends to wake back up.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) captureThumbnail(windowId, tab.id).catch(() => {});
  } catch (e) {
    // window closed between the event and the query
  }
});

chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  forgetTabCaptureTime(tabId);
  removeTab(windowId, tabId);
  removeTabFromCycles(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  commandQueues.delete(windowId);
  endCycle(windowId);
  forgetWindow(windowId);
});

/* ------------------------------------------------------------------ *
 * Starting a cycle
 * ------------------------------------------------------------------ */

// Resolve the MRU id list into everything a card needs to render. One query for
// the whole window rather than a chrome.tabs.get per entry: those awaits ran
// sequentially, so a full list cost a dozen round-trips before anything could
// render — long enough that a quick tap-and-release was already over by the time
// the overlay appeared, making it flash and vanish. Everything here is on the
// critical path before the first paint.
async function buildTabInfos(windowId, ids) {
  const byId = new Map();
  const groupById = new Map();
  // Both in one parallel step — everything here is on the critical path
  // before the overlay can paint.
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }).catch(() => []),
  ]);
  for (const t of tabs) byId.set(t.id, t);
  for (const g of groups) groupById.set(g.id, g);

  // Only the tabs about to be rendered, and only those not already in memory.
  await loadThumbnails(ids.map((id) => byId.get(id) && byId.get(id).url));

  const tabInfos = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) continue; // tab no longer exists; skip
    // groupId is -1 (TAB_GROUP_ID_NONE) for ungrouped tabs.
    const group = t.groupId > -1 ? groupById.get(t.groupId) : null;
    tabInfos.push({
      id: t.id,
      title: displayTitle(t),
      favIconUrl: faviconUrlFor(t.url) || t.favIconUrl || '',
      // For the no-thumbnail placeholder, which draws the icon at 32px.
      favIconLarge: faviconUrlFor(t.url, 64) || t.favIconUrl || '',
      thumbnail: thumbnailFor(t.url),
      group: group ? { title: group.title || '', color: group.color } : null,
    });
  }
  return { tabInfos, windowTabs: byId.size };
}

async function startCycle(tab) {
  const windowId = tab.windowId;
  // Stamped before any await so it predates every hop between the keypress and
  // the panel appearing. The overlay reports when it last saw a modifier
  // release; if that is newer than this, the user let go while we were still
  // getting the panel up and there is no hold left to wait on.
  const startedAt = Date.now();
  const ids = mruIds(windowId);

  let built;
  try {
    built = await buildTabInfos(windowId, ids);
  } catch (e) {
    log('startCycle: could not read the window', { error: errMsg(e) });
    return;
  }
  const { tabInfos, windowTabs } = built;

  log('startCycle', {
    ms: Date.now() - startedAt,
    activeTabId: tab.id,
    mruIds: ids.length,
    resolved: tabInfos.length,
    windowTabs,
  });
  if (tabInfos.length < 2) {
    log('startCycle: ABORT, fewer than 2 resolvable tabs');
    return; // nothing to switch to
  }

  const startIndex = 1; // previously active tab
  const target = tabInfos[startIndex];

  const shown = await tryShowOverlay(tab.id, tabInfos, startIndex);
  if (!shown) {
    // Restricted page: no overlay can ever render here, so there is nothing to
    // cycle within. Switch once and store NOTHING.
    await quickSwitch(target);
    return;
  }

  // The release already happened — the panel went up after the hold ended, so
  // nothing further will arrive to close it. Finish the switch now instead of
  // leaving it on screen waiting for an event that is already in the past.
  if (shown.releasedAt && shown.releasedAt >= startedAt) {
    log('release predates paint; committing immediately', {
      startedAt,
      releasedAt: shown.releasedAt,
    });
    chrome.tabs.sendMessage(tab.id, { type: 'teardown' }).catch(() => {});
    if (target) activateTab(target.id);
    return;
  }

  setCycleState(windowId, {
    tabInfos,
    index: startIndex,
    overlayTabId: tab.id,
    focused: shown.focused !== false,
  });
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
async function quickSwitch(target) {
  if (!target) return;
  log('quickSwitch (restricted page): stateless jump', { to: target.id });
  await activateTab(target.id);
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
//
// Ceiling on any single queued command. The queue is strictly serial, so
// without this one slow step blocks every later press behind it — a
// sendMessage to a busy or unresponsive page can sit there indefinitely, and
// the presses queued behind it then arrive in a burst. That reads as lag that
// worsens with use rather than as a hang. Losing the tail of a slow command is
// much cheaper than stalling the queue.
const COMMAND_TIMEOUT_MS = 1500;

function enqueueCommand(windowId, task) {
  const previous = commandQueues.get(windowId) || Promise.resolve();
  const run = () => withTimeout(task(), COMMAND_TIMEOUT_MS, 'command');
  const next = previous.then(run, run);
  commandQueues.set(windowId, next.catch(() => {}));
  return next;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'cycle-tabs' || !tab) return;
  const windowId = tab.windowId;

  // Timestamps around each stage, to tell apart the three places time can go:
  // before the command reaches us at all (Chrome/OS dispatch, or a worker
  // cold-start we never see), waiting on init/the command queue, and our own
  // work. Only the last two are ours to fix.
  const receivedAt = Date.now();
  log('command received');

  enqueueCommand(windowId, async () => {
    await ensureMru();
    log('command ready', { waitedMs: Date.now() - receivedAt });
    let state = getCycle(windowId);

    // Never trust a timer to have ended the previous cycle.
    if (state && isStale(state)) {
      log('command: discarding stale cycle');
      closeCycle(windowId);
      state = null;
    }

    log('command', {
      activeTabId: tab.id,
      url: (tab.url || '').slice(0, 60),
      hasState: !!state,
    });

    if (!state) {
      await startCycle(tab);
      log('command done (new cycle)', { totalMs: Date.now() - receivedAt });
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
    log('command done (advance)', { totalMs: Date.now() - receivedAt });
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const windowId = sender.tab && sender.tab.windowId;
  if (windowId === undefined) return;
  const state = getCycle(windowId);
  if (!state) return;

  if (msg.type === 'confirm-switch') {
    log('confirm-switch received', { fromFrameId: sender.frameId, index: msg.index });
    const index = typeof msg.index === 'number' ? msg.index : state.index;
    const target = state.tabInfos[index];
    // closeCycle broadcasts the teardown rather than assuming the sender removed
    // the panel. A release caught in an iframe arrives here from a frame that
    // has no panel of its own, so the top frame would otherwise keep it on
    // screen. Reaching the sender too is harmless — it has already torn itself
    // down.
    closeCycle(windowId);
    if (target) activateTab(target.id);
  } else if (msg.type === 'cancel') {
    closeCycle(windowId);
  }
});

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
