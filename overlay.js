(function () {
  if (window.__mruOverlayLoaded) return;
  window.__mruOverlayLoaded = true;

  const CARD_WIDTH_PX = 190;
  const MAX_COLUMNS = 6;

  // Which key ending the hold commits the highlighted tab. Kept general rather
  // than hardcoding Control so the switcher still works if the command is
  // rebound to an Alt- or Command-based shortcut.
  const MODIFIER_KEYS = ['Control', 'Alt', 'Meta'];

  let debugMode = false;
  function dlog(...args) {
    if (debugMode) console.log('[mru overlay]', window.top === window ? 'top' : 'frame', ...args);
  }

  function endsHold(e) {
    // Another modifier still down (e.g. Control released while Shift is held
    // for a reverse-cycle binding) means the hold isn't over yet.
    return MODIFIER_KEYS.includes(e.key) && !(e.ctrlKey || e.altKey || e.metaKey);
  }

  // Sub-frames draw nothing. They run at all because keyboard events go to the
  // frame that has focus, so whenever focus sits inside an iframe the top
  // document never sees the release and the panel would hang on screen until
  // clicked. This forwards that release instead.
  if (window.top !== window) {
    let cycleActive = false;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'show') {
        cycleActive = true;
        debugMode = !!msg.debug;
      }
      else if (msg.type === 'teardown') cycleActive = false;
      // Deliberately never calls sendResponse — the top frame owns the reply
      // that tryShowOverlay inspects to decide whether the panel painted.
    });
    document.addEventListener(
      'keyup',
      (e) => {
        if (!MODIFIER_KEYS.includes(e.key)) return;
        dlog('keyup', { key: e.key, cycleActive, endsHold: endsHold(e) });
        if (!cycleActive || !endsHold(e)) return;
        cycleActive = false;
        chrome.runtime.sendMessage({ type: 'confirm-switch' });
      },
      true
    );
    return;
  }

  // chrome.tabGroups reports a color name, not a value. These approximate
  // Chrome's own group palette so a badge reads as the same group you see in
  // the tab strip.
  const GROUP_COLORS = {
    grey: '#5F6368',
    blue: '#1A73E8',
    red: '#D93025',
    yellow: '#F9AB00',
    green: '#1E8E3E',
    pink: '#D01884',
    purple: '#9334E6',
    cyan: '#007B83',
    orange: '#FA903E',
  };

  const STYLE = `
    /* The panel is frosted glass, so whatever is behind it tints it. Two
       independent things can darken it: the OS being in dark mode, and simply
       sitting over a dark page while the OS is light. prefers-color-scheme
       only covers the first, so the palette below also runs at a higher alpha
       than the original 0.72 — enough that page content behind can no longer
       drag the panel far from its intended tone. Every colour that has to stay
       readable against it is a variable, so the two themes can't drift. */
    .panel {
      --panel-bg: rgba(255, 255, 255, 0.86);
      --card-active: rgba(0, 0, 0, 0.14);
      --card-active-ring: rgba(0, 0, 0, 0.32);
      --title: #1a1a1a;
      --thumb-bg: #f4f5f7;
      --thumb-ring: rgba(0, 0, 0, 0.08);
      --favicon-blank: rgba(0, 0, 0, 0.12);

      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: grid;
      gap: 4px;
      padding: 10px;
      background: var(--panel-bg);
      border-radius: 22px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      backdrop-filter: blur(24px) saturate(1.6);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      pointer-events: auto;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --panel-bg: rgba(32, 33, 36, 0.88);
        --card-active: rgba(255, 255, 255, 0.18);
        --card-active-ring: rgba(255, 255, 255, 0.75);
        --title: #e8eaed;
        --thumb-bg: #2a2b2e;
        --thumb-ring: rgba(255, 255, 255, 0.12);
        --favicon-blank: rgba(255, 255, 255, 0.20);
      }
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px;
      border-radius: 12px;
      box-sizing: border-box;
      background: transparent;
      cursor: pointer;
    }
    /* No transition on the selected state. The fill and the ring are different
       properties, so any duration desynchronises them — and at key-repeat speed
       a 100ms fade leaves several cards part-highlighted at once, which reads
       as flicker. Stepping feedback should be immediate anyway. */
    /* Selection is carried by a crisp ring, not only by the fill. A tint alone
       is a few shades of difference that the frosted backdrop can wash out;
       an inset ring stays legible whatever ends up behind the panel. Inset so
       it can't bleed into the 4px gap between cards. */
    .card--active {
      background: var(--card-active);
      box-shadow: inset 0 0 0 2px var(--card-active-ring);
    }
    .thumb-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: 6px;
      overflow: hidden;
      background: var(--thumb-bg);
      box-shadow: 0 0 0 1px var(--thumb-ring);
    }
    .thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top;
      display: block;
    }
    .thumb--blank {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .group-badge {
      position: absolute;
      top: 4px;
      left: 4px;
      max-width: calc(100% - 8px);
      box-sizing: border-box;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.4;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thumb-fallback-icon {
      width: 32px;
      height: 32px;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 2px;
      box-sizing: border-box;
      min-width: 0;
    }
    .favicon {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .favicon--blank {
      background: var(--favicon-blank);
    }
    .title {
      font-size: 12px;
      font-weight: 400;
      color: var(--title);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  `;

  // When a modifier release was last seen. Recorded from page load, not from
  // when the panel appears: the command can take a while to reach us (a cold
  // service worker has to restore its caches first), and a quick tap-and-release
  // lands entirely inside that gap. Registering the listener at paint time meant
  // that release was simply lost and the panel hung until it expired. Now the
  // fact is remembered and reported back, so the background can see the hold
  // already ended.
  let lastReleaseAt = 0;

  // The panel polices its own lifetime. It used to rely on an expiry timer in
  // the service worker, but MV3 suspends the worker between events and drops
  // pending setTimeouts — so whenever a release went unseen, nothing ever ran
  // to remove the panel and it hung indefinitely. A timer in the page runs for
  // as long as the tab is visible, which is exactly the window in which the
  // panel can be on screen.
  const WATCHDOG_TICK_MS = 120;
  // No keyup can reach a document that doesn't have focus (the omnibox, another
  // app), so once idle this long there is nothing left to wait for. This is the
  // visible hang when a release goes unseen — worst case is this plus one tick —
  // so it is kept only as long as a comfortable tap cadence needs, not as long
  // as a pause to read: while unfocused there is no release to read *for*, since
  // letting go cannot be observed. hasFocus is re-checked every tick, so focus
  // arriving late (right after a tab or window switch) cancels this path rather
  // than racing it.
  const UNFOCUSED_IDLE_MS = 700;
  // Absolute ceiling for a focused page, where a real release is expected.
  const MAX_PANEL_MS = 30000;
  let watchdogId = null;
  let lastActivityAt = 0;

  let host = null;
  let shadow = null;
  let cardEls = [];
  let tabsData = [];
  let currentIndex = 0;
  let lastMouseX = null;
  let lastMouseY = null;

  function img(className, src) {
    const el = document.createElement('img');
    el.className = className;
    el.src = src;
    el.alt = '';
    return el;
  }

  function div(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  function buildThumb(tab) {
    const wrap = div('thumb-wrap');

    if (tab.thumbnail) {
      wrap.appendChild(img('thumb', tab.thumbnail));
    } else {
      // No screenshot yet (tab not visited since the worker started, or it's a
      // page we can't capture) — show the favicon centered on a blank plate.
      const blank = div('thumb thumb--blank');
      if (tab.favIconUrl) blank.appendChild(img('thumb-fallback-icon', tab.favIconUrl));
      wrap.appendChild(blank);
    }

    // Chrome allows unnamed groups; a nameless pill would say nothing, so only
    // titled groups get a badge.
    if (tab.group && tab.group.title) {
      const badge = div('group-badge');
      badge.textContent = tab.group.title;
      badge.style.background = GROUP_COLORS[tab.group.color] || GROUP_COLORS.grey;
      wrap.appendChild(badge);
    }

    return wrap;
  }

  function buildCard(tab, index) {
    const card = div('card');
    card.dataset.index = String(index);
    card.appendChild(buildThumb(tab));

    const meta = div('meta');
    meta.appendChild(tab.favIconUrl ? img('favicon', tab.favIconUrl) : div('favicon favicon--blank'));
    const title = div('title');
    title.textContent = tab.title;
    meta.appendChild(title);

    card.appendChild(meta);
    return card;
  }

  // Full rebuild — only on a new cycle or when the tab list itself changes.
  function buildPanel() {
    shadow.replaceChildren();

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const panel = div('panel');
    const columns = Math.min(Math.max(tabsData.length, 1), MAX_COLUMNS);
    panel.style.gridTemplateColumns = `repeat(${columns}, ${CARD_WIDTH_PX}px)`;

    cardEls = tabsData.map((tab, i) => {
      const card = buildCard(tab, i);
      panel.appendChild(card);
      return card;
    });

    shadow.appendChild(panel);
    setActive(currentIndex);
  }

  // Moving the highlight only toggles a class. Re-rendering the whole panel
  // here would re-decode every thumbnail on each step of the cycle.
  function setActive(index) {
    currentIndex = index;
    for (let i = 0; i < cardEls.length; i++) {
      cardEls[i].classList.toggle('card--active', i === index);
    }
  }

  function noteActivity() {
    lastActivityAt = Date.now();
    if (watchdogId === null) watchdogId = setInterval(checkWatchdog, WATCHDOG_TICK_MS);
  }

  function checkWatchdog() {
    if (!host) {
      stopWatchdog();
      return;
    }
    const idle = Date.now() - lastActivityAt;

    // Unfocused: the release is unobservable here, so waiting cannot resolve
    // anything. Commit rather than cancel — pressing the shortcut was a request
    // to switch, and honouring it beats discarding it. Each cycle step calls
    // noteActivity, so this only fires on a genuine pause.
    if (!document.hasFocus() && idle > UNFOCUSED_IDLE_MS) {
      dlog('watchdog: unfocused and idle, committing', { idle });
      chrome.runtime.sendMessage({ type: 'confirm-switch', index: currentIndex });
      teardown();
      return;
    }

    // Focused and still up after the ceiling: a release should have arrived and
    // didn't. Cancel here rather than commit — at this distance from the
    // keypress the highlighted tab is no longer a safe guess at intent.
    if (idle > MAX_PANEL_MS) {
      dlog('watchdog: ceiling reached, cancelling', { idle });
      dismiss();
    }
  }

  function stopWatchdog() {
    if (watchdogId !== null) {
      clearInterval(watchdogId);
      watchdogId = null;
    }
  }

  function teardown() {
    dlog('teardown');
    stopWatchdog();
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
    cardEls = [];
    lastMouseX = null;
    lastMouseY = null;
    // Listeners are deliberately NOT removed — see the registration below.
  }

  function onKeyUp(e) {
    if (MODIFIER_KEYS.includes(e.key)) {
      dlog('keyup', {
        key: e.key,
        ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        endsHold: endsHold(e),
        hasFocus: document.hasFocus(),
        activeEl: document.activeElement && document.activeElement.tagName,
      });
    }
    if (!endsHold(e)) return;
    lastReleaseAt = Date.now();
    if (!host) return; // no panel yet; the timestamp above is the record of it
    chrome.runtime.sendMessage({ type: 'confirm-switch', index: currentIndex });
    teardown();
  }

  function dismiss() {
    chrome.runtime.sendMessage({ type: 'cancel' });
    teardown();
  }

  // Safety nets for a release this document will never see — focus sitting in
  // the omnibox or another app means no keyup reaches any frame at all. Rather
  // than leave the panel stranded, treat the user doing something else as the
  // end of the cycle. These cancel rather than commit: a stray click or an app
  // switch is not a choice of tab, and switching on one would be worse than
  // making the user press the shortcut again.
  function onPointerDown(e) {
    if (!host || e.target === host) return; // inside the panel; the card click handles it
    dismiss();
  }

  function onWindowBlur() {
    if (host) dismiss();
  }

  function onVisibilityChange() {
    if (host && document.visibilityState === 'hidden') dismiss();
  }

  function onKeyDown(e) {
    if (host && e.key === 'Escape') dismiss();
  }

  function cardIndexFromEvent(e) {
    const card = e.target.closest('.card');
    return card ? Number(card.dataset.index) : -1;
  }

  function onCardHover(e) {
    // Deliberately mousemove rather than mouseover: mouseover also fires when a
    // new element lands under a stationary cursor, which would let a cursor
    // that merely happens to rest over the panel steal the highlight away from
    // keyboard cycling. Comparing coordinates keeps it to real movement.
    if (lastMouseX === e.clientX && lastMouseY === e.clientY) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    const idx = cardIndexFromEvent(e);
    if (idx === -1 || idx === currentIndex) return;
    setActive(idx);
  }

  function onCardClick(e) {
    const idx = cardIndexFromEvent(e);
    if (idx === -1) return;
    chrome.runtime.sendMessage({ type: 'confirm-switch', index: idx });
    teardown();
  }

  // macOS treats Control+click as a secondary click, and the switcher is used
  // with Control held — so clicking a card fires contextmenu instead of click,
  // popping the page's menu over the panel and selecting nothing. Suppress the
  // menu anywhere inside the panel and treat a hit on a card as the pick it was
  // meant to be. On Windows and Linux this simply never fires.
  function onCardContextMenu(e) {
    e.preventDefault();
    const idx = cardIndexFromEvent(e);
    if (idx === -1) return; // panel background — menu suppressed, nothing picked
    chrome.runtime.sendMessage({ type: 'confirm-switch', index: idx });
    teardown();
  }

  function sameTabList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
    }
    return true;
  }

  function showOverlay(tabs, index, debug) {
    debugMode = !!debug;
    dlog('show', { tabs: tabs.length, index, hasFocus: document.hasFocus() });
    // A 'show' can arrive while the panel is already up — a tab closing rebuilds
    // the list, and a restarted cycle re-sends it. Rebuilding then means
    // replaceChildren plus re-decoding every thumbnail, which flashes. When the
    // same tabs are still in the same order there is nothing to rebuild.
    const unchanged = !!host && sameTabList(tabsData, tabs);

    tabsData = tabs;
    currentIndex = index;
    noteActivity();

    if (unchanged) {
      setActive(index);
      return;
    }

    if (!host) {
      host = document.createElement('div');
      host.id = 'mru-tab-switcher-host';
      // pointer-events: none so the full-viewport host never blocks the page;
      // the panel itself re-enables them so cards stay hoverable and clickable.
      host.style.cssText =
        'all: initial; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; pointer-events: none;';
      document.documentElement.appendChild(host);
      shadow = host.attachShadow({ mode: 'open' });
      // Shadow-scoped listeners die with the shadow root, so these belong here.
      shadow.addEventListener('mousemove', onCardHover);
      shadow.addEventListener('click', onCardClick);
      shadow.addEventListener('contextmenu', onCardContextMenu);
    }

    buildPanel();
  }

  // Registered once at page load and never removed. The keyup listener has to
  // pre-date the panel — that is the whole point, since the release we kept
  // losing happened before the panel existed. The rest ride along for symmetry
  // and each no-ops while `host` is null, which costs nothing and removes the
  // add/remove churn that made listener lifetime a thing to get wrong.
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onPointerDown, true);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Report back whether the panel actually painted. A resolved sendMessage
    // only proves something was listening, so without this an overlay that
    // threw while building would still be reported as shown.
    try {
      if (msg.type === 'show') {
        showOverlay(msg.tabs, msg.index, msg.debug);
        sendResponse({
          ok: true,
          painted: !!host,
          focused: document.hasFocus(),
          releasedAt: lastReleaseAt,
        });
      } else if (msg.type === 'update') {
        noteActivity();
        setActive(msg.index);
        sendResponse({
          ok: true,
          painted: !!host,
          focused: document.hasFocus(),
          releasedAt: lastReleaseAt,
        });
      } else if (msg.type === 'teardown') {
        teardown();
        sendResponse({ ok: true, painted: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false; // responded synchronously
  });
})();
