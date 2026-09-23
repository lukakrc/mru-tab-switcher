import { errMsg, log } from './log.js';

export function faviconUrlFor(pageUrl, size = 32) {
  // tab.favIconUrl is empty for chrome:// pages; this API resolves an icon for
  // any URL, internal pages included. `size` is in device pixels, so an icon
  // drawn at N css px wants 2N on a Retina display.
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

// What to call a tab on its card. Until a page supplies a <title>, Chrome
// reports the URL itself, which truncates to "https://www.exam…" at card
// width — the host alone is shorter and says more.
export function displayTitle(tab) {
  const url = tab.url || '';
  const title = tab.title || '';
  const isJustTheUrl = !title || title === url || title === url.replace(/^[a-z]+:\/\//, '');
  if (!isJustTheUrl) return title;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host) return host;
  } catch (e) {
    // not a parseable URL; fall through
  }
  return title || url || 'Untitled';
}

// Every switch this extension performs goes through here. Failure means the
// tab disappeared between being listed and being chosen, which needs no
// handling beyond not throwing — there is nothing left to switch to.
export async function activateTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    log('activateTab failed', { tabId, error: errMsg(e) });
  }
}
