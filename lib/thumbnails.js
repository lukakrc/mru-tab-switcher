import { log, errMsg } from './log.js';
import { once, trimLru } from './async.js';
import { isCycleRunning } from './cycle.js';

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

// url -> capture time, for every thumbnail in storage. This is the whole cache
// directory in a few KB, and it is all that gets loaded on a worker wake; the
// image data itself is fetched per cycle for just the tabs on screen.
const thumbIndex = new Map();
const THUMB_INDEX_KEY = 'thumbIndex';
// The in-memory image cache is a working set, not the whole store — it only
// needs to cover a cycle's worth of tabs plus recent captures.
const MAX_MEMORY_THUMBNAILS = 24;
const THUMB_PREFIX = 'thumb:';
// The card renders 190px wide, so 400 covers a 2x display with nothing spare.
// These three are the size knobs: width dominates, quality is the fine tune.
const THUMB_WIDTH_PX = 400;
const THUMB_MIME = 'image/webp';
const THUMB_QUALITY = 0.6;
const MAX_STORED_THUMBNAILS = 60;

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

// A per-tab throttle is not enough with more than one window open. Every window
// focus change captures, so alternating between two windows fires a capture per
// switch, each on a different tab and so each passing the per-tab check. Capture
// is the most expensive thing this worker does, and it runs on the same single
// thread as command handling — a run of them delays the next keypress. This
// caps the total rate across all windows and tabs.
const MIN_GLOBAL_CAPTURE_MS = 1000;
let lastAnyCaptureAt = 0;

export function forgetTabCaptureTime(tabId) {
  // The thumbnail cache itself is keyed by URL and deliberately outlives the
  // tab — that is what lets a reopened page show a preview straight away. Only
  // the throttle bookkeeping is per-tab.
  lastCaptureAt.delete(tabId);
}

export async function captureThumbnail(windowId, tabId) {
  const now = Date.now();
  // A cycle in progress owns the thread. Thumbnails are a nicety; responding to
  // the shortcut is the job.
  if (isCycleRunning()) return;
  if (now - lastAnyCaptureAt < MIN_GLOBAL_CAPTURE_MS) return;
  if (now - (lastCaptureAt.get(tabId) || 0) < MIN_CAPTURE_INTERVAL_MS) return;
  lastCaptureAt.set(tabId, now);
  lastAnyCaptureAt = now;

  let url;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch (e) {
    return; // tab vanished
  }
  if (!url || !/^https?:/.test(url)) return; // nothing worth caching

  // Checked again on each side of the capture, not just on entry: a cycle can
  // start while this is awaiting, and the panel is then on screen by the time
  // the frame is grabbed. Thumbnails are cached by URL, so a capture with the
  // switcher in it would keep showing up on that page's card.
  if (isCycleRunning()) return;

  let thumbnail;
  try {
    // Quality only affects this intermediate: it is decoded, scaled down ~8x
    // and re-encoded, then discarded. A cheaper source means less decode work
    // on the worker's single thread, which is shared with command handling.
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 40 });
    if (isCycleRunning()) return;
    thumbnail = await downscale(raw);
  } catch (e) {
    // Restricted page, rate-limited, or window not focused — keep any existing
    // thumbnail rather than blanking the card.
    return;
  }

  remember(url, thumbnail, now);

  const evicted = [];
  while (thumbIndex.size > MAX_STORED_THUMBNAILS) {
    const oldest = thumbIndex.keys().next().value;
    thumbIndex.delete(oldest);
    thumbnailsByUrl.delete(oldest);
    evicted.push(THUMB_PREFIX + oldest);
  }

  try {
    await chrome.storage.local.set({ [THUMB_PREFIX + url]: thumbnail });
    if (evicted.length) await chrome.storage.local.remove(evicted);
    await persistThumbIndex();
  } catch (e) {
    log('thumbnail persist failed', { url, error: errMsg(e) });
  }
}

// Both maps are LRU queues: delete-then-set moves an entry to the newest end.
function remember(url, thumbnail, at) {
  thumbIndex.delete(url);
  thumbIndex.set(url, at);
  thumbnailsByUrl.delete(url);
  thumbnailsByUrl.set(url, thumbnail);
  trimLru(thumbnailsByUrl, MAX_MEMORY_THUMBNAILS);
}

// What a cycle actually renders: whatever is already in the working set.
export function thumbnailFor(url) {
  return thumbnailsByUrl.get(url) || null;
}

async function persistThumbIndex() {
  const obj = {};
  for (const [url, at] of thumbIndex) obj[url] = at;
  try {
    await chrome.storage.local.set({ [THUMB_INDEX_KEY]: obj });
  } catch (e) {
    // index is a cache of a cache; losing it only costs a rebuild
  }
}

// Pull just the thumbnails this cycle needs out of storage. Reading the whole
// store on every worker wake is what made the shortcut lag: the worker sleeps
// after ~30s idle, so most presses paid for deserialising ~1MB of base64 before
// the keypress was even handled, and it got steadily worse as the cache filled.
// A dozen targeted keys is a few milliseconds instead.
export async function loadThumbnails(urls) {
  await ensureThumbIndex();
  const missing = [];
  for (const url of urls) {
    if (url && thumbIndex.has(url) && !thumbnailsByUrl.has(url)) missing.push(url);
  }
  if (!missing.length) return;

  try {
    const got = await chrome.storage.local.get(missing.map((u) => THUMB_PREFIX + u));
    for (const url of missing) {
      const value = got[THUMB_PREFIX + url];
      if (!value) continue;
      // Entries written before the index existed were wrapped as { d, at }.
      thumbnailsByUrl.set(url, typeof value === 'string' ? value : value.d);
    }
    trimLru(thumbnailsByUrl, MAX_MEMORY_THUMBNAILS);
  } catch (e) {
    log('thumbnail load failed', { error: errMsg(e) });
  }
}

// Loads the index only — a few KB of urls and timestamps, no image data.
async function restoreThumbIndex() {
  let stored;
  try {
    stored = await chrome.storage.local.get(THUMB_INDEX_KEY);
  } catch (e) {
    return;
  }

  const index = stored[THUMB_INDEX_KEY];
  if (index) {
    // Oldest first, so the Map stays a valid LRU queue and eviction pops the front.
    for (const [url, at] of Object.entries(index).sort((a, b) => a[1] - b[1])) {
      thumbIndex.set(url, at);
    }
    return;
  }

  // One-time migration for stores written before the index existed. Costs a
  // single full read, then never again.
  await rebuildThumbIndex();
}

async function rebuildThumbIndex() {
  let stored;
  try {
    stored = await chrome.storage.local.get(null);
  } catch (e) {
    return;
  }

  const entries = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(THUMB_PREFIX) || !value) continue;
    entries.push({
      url: key.slice(THUMB_PREFIX.length),
      at: typeof value === 'object' && value.at ? value.at : 0,
    });
  }
  entries.sort((a, b) => a.at - b.at);

  const overflow = entries.splice(0, Math.max(0, entries.length - MAX_STORED_THUMBNAILS));
  for (const e of entries) thumbIndex.set(e.url, e.at);
  if (overflow.length) {
    chrome.storage.local.remove(overflow.map((e) => THUMB_PREFIX + e.url)).catch(() => {});
  }
  await persistThumbIndex();
  log('thumbnail index rebuilt', { entries: thumbIndex.size, dropped: overflow.length });
}

export const ensureThumbIndex = once(restoreThumbIndex, 'restoreThumbIndex');

export function indexedCount() {
  return thumbIndex.size;
}
