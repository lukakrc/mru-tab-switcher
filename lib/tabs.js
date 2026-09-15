import { errMsg, log } from './log.js';

export function faviconUrlFor(pageUrl) {
  // tab.favIconUrl is empty for chrome:// pages; this API resolves an icon for
  // any URL, internal pages included.
  if (!pageUrl) return '';
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
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
