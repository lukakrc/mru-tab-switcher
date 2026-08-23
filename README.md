# MRU Tab Switcher

Arc-style most-recently-used tab switching for Chrome. Hold `Control` and tap
`Tab` to cycle through up to 12 recent tabs in a translucent overlay showing
live page thumbnails; release `Control` to jump to the highlighted tab. Hover
and click work too, and `Escape` cancels.

On `chrome://` pages the overlay can't be drawn at all — see
[Restricted pages](#restricted-pages) for how it degrades there.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this folder.
2. Approve the host permission prompt. It's needed for `captureVisibleTab` to
   screenshot tabs for the thumbnails; nothing leaves the machine.
3. Bind `Ctrl+Tab` — see below.

## Binding Ctrl+Tab

`Ctrl+Tab` **cannot** be set from `manifest.json` or from the keyboard-shortcuts
UI. Chrome reserves it, and `Tab` was removed from the allowed command keys in
Chrome 33 — putting it in the manifest doesn't just get ignored, it can stop the
extension loading. The manifest therefore declares a harmless `MacCtrl+Q`
default, and the real binding is applied through a private API that bypasses
that restriction.

Open `chrome://extensions/shortcuts`, open DevTools (`⌘⌥J`), and run:

```js
chrome.developerPrivate.getExtensionsInfo()
  .then(l => {
    var e = l.find(x => x.name.includes('MRU'));
    chrome.developerPrivate.updateExtensionCommand({
      extensionId: e.id,
      commandName: 'cycle-tabs',
      keybinding: 'Ctrl+Tab',
    });
    console.log('bound', e.name, e.id);
  });
```

Reload the page; the row should read `⌃Tab`.

Notes:

- Use `Ctrl`, not `MacCtrl`. `MacCtrl` is a manifest-level token that this API
  rejects — it silently clears the binding to "Not set" instead of erroring.
- The binding lives in Chrome's preferences keyed by extension ID, not in this
  repo. The unpacked ID is derived from the folder path, so it survives reloads,
  but re-run the snippet if it ever reverts.
- This takes over Chrome's native `Ctrl+Tab` / `Ctrl+Shift+Tab` tab navigation.
  `Cmd+Opt+→/←` still moves between adjacent tabs.
- If DevTools refuses to paste, type `allow pasting` into the console once.

## How it works

`background.js` tracks per-window MRU order (persisted to session storage so it
survives service-worker restarts) and caches a JPEG screenshot of each tab as
you leave it. On the shortcut it freezes the current MRU list, shows
`overlay.js` in the active tab, and advances the highlight on each press. The
overlay watches for the real `keyup` and reports the chosen index back.

### Ending the hold

Keyboard events go to whichever frame has focus, so the top document alone is
not enough to catch the release — with focus inside an iframe the panel would
hang on screen. `overlay.js` therefore runs in all frames: sub-frames draw
nothing and only forward a release to the background, which broadcasts the
teardown rather than assuming the sender owned the panel.

Focus in browser UI (the omnibox) is not recoverable that way — no frame sees
any key event at all. The overlay reports `document.hasFocus()` when it paints,
and a cycle that starts unfocused expires in 4s instead of 30s so the panel
can't strand. Window blur, tab hide, and a mousedown outside the panel also
dismiss it. Those all *cancel* rather than commit: a stray click or an app
switch is not a choice of tab.

Everything before the overlay's first paint is on the critical path: if it
appears later than the release of a quick tap, the panel just flashes and
vanishes. So `overlay.js` is declared as a content script (already resident, one
message to paint, with `executeScript` only as a fallback for tabs that predate
the extension loading), and the tab list is gathered with a single
`chrome.tabs.query` rather than a `chrome.tabs.get` per entry.

Commands are queued per window, because OS key-repeat can deliver a new command
before the previous one's async work has finished.

### Restricted pages

Chrome forbids content scripts on `chrome://` pages and the Web Store, so no
overlay can render while one is in front. A cycle started there runs in **blind
mode**: no UI, and each press steps back one tab immediately, walking the same
frozen list so repeated taps still traverse history correctly. Start a cycle
from any normal page and you get the full hold-to-preview overlay.

Blind mode deliberately stays blind for the whole cycle rather than popping the
overlay up once it reaches a scriptable tab. Switching to a tab and injecting
into it takes three async hops, and a quick tap-and-release fires `keyup` during
them — before the overlay's listener exists. That release is unrecoverable, and
the panel would hang on screen until the cycle expired. An overlay that can't
observe its own dismissal is worse than no overlay.

Cycle state expires after 1.5s in blind mode (nothing else can end it) versus
30s in overlay mode, where the overlay itself detects the release. Expiry never
switches tabs — it ends the cycle and leaves you where you are.

**Expiry is enforced by timestamp, not by the timer.** MV3 service workers are
suspended between events and pending `setTimeout` callbacks are dropped, so a
timer is best-effort only. Each cycle is stamped with `touchedAt` and staleness
is checked when a command arrives. Building on the timer alone caused a
memorable bug: one activation from a `chrome://` page created blind state whose
timer never fired, so every later press took the blind path and the overlay
never appeared again until the extension was reloaded. If you add state here,
stamp it and check it on arrival — do not trust a timer to clean it up.

### Tab groups

A tab in a named Chrome tab group gets a small badge in the top-left of its
thumbnail, tinted with that group's own colour (`chrome.tabGroups` reports a
colour *name*, so `GROUP_COLORS` in `overlay.js` maps those to Chrome's
palette). Unnamed groups get no badge — a nameless pill communicates nothing.
Groups are fetched with a single `chrome.tabGroups.query` alongside the tab
query, in the same parallel step, since this is on the pre-paint critical path.

### Thumbnails

Screenshots are captured on tab activation, on navigation completing in the
active tab, and when a window regains focus — throttled to one capture per tab
per 500ms, since redirect chains fire several events in a row.

The cache is keyed by **URL**, not tab id, and persisted to
`chrome.storage.local` (capped at 60 entries, oldest evicted). That means a
preview outlives both the tab and the browser session: a tab restored at startup
shows its previous thumbnail immediately, and so does a brand-new tab opened on
a page seen before. Tab ids can't do this — Chrome reassigns them on restart.
Entries carry a timestamp so the LRU order survives a restart too, and the whole
set is loaded on worker wake to keep the render path in memory.

Nothing is stored at full resolution. Each capture is downscaled to
`THUMB_WIDTH_PX` (400 — the card renders at 190, so this covers a 2x display
with nothing spare) and re-encoded as WebP at quality 0.6, landing around
10-18KB per entry; the original capture is discarded. Width and quality are the
knobs if that needs tuning. WebP is safe here because only Chrome ever decodes
these, but `convertToBlob` silently falls back to PNG for a type it can't
encode, so the result is checked and re-encoded as JPEG rather than trusted.
Turn on `DEBUG` to log the real encoded size of each thumbnail.

Chrome still cannot screenshot a *background* tab — `captureVisibleTab` only
ever sees the visible one — so a page never visited has no preview to reuse and
falls back to its favicon. The alternatives were briefly activating every tab
(visible flicker) and `chrome.debugger` (a permanent "started debugging this
browser" infobar); both are worse than a placeholder.

**Privacy:** this writes page screenshots to disk. Only `http(s)` pages are
cached, but a screenshot captures whatever was on the page, signed-in content
included. To wipe the cache, run `chrome.storage.local.clear()` in the service
worker console (`chrome://extensions` → **service worker**).

Captures are downscaled to 400px wide before being kept — the card only renders
at 190px, so full-resolution frames are pure waste — and then mirrored into
`chrome.storage.session` under `thumb:<tabId>`, pruned when a tab closes and
capped at 40 entries. The downscale is what makes storing them affordable at
all. Holding them in memory only meant they disappeared every time the service
worker was terminated, which Chrome does ~30s after it goes idle — so focusing
another app and coming back emptied every thumbnail.
