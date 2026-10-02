(function () {
  if (window.__mruOverlayLoaded) return;
  window.__mruOverlayLoaded = true;

  const CARD_WIDTH_PX = 190;
  const MAX_COLUMNS = 6;
  const PANEL_PADDING_PX = 10;
  const GRID_GAP_PX = 4;
  // Breathing room between the panel and the window edge.
  const VIEWPORT_MARGIN_PX = 24;
  // How small a card may get before a column is given up instead. Below this
  // the thumbnails stop being recognisable at a glance, which is their job.
  const MIN_CARD_WIDTH_PX = 140;

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

  // Whether a cycle modifier is down right now, as far as this document can
  // tell: true or false once a key event has said so, null when it can't know.
  // Window blur resets it — focus moving to another frame, the omnibox, another
  // tab or another app means key events stop arriving here, so the last one
  // seen says nothing about the present.
  //
  // This is what catches a quick tap whose release beats the panel: both the
  // keydown and the keyup land here before 'show' does, so false on arrival
  // means the hold is already over. Comparing a release timestamp with the
  // service worker's clock could not do this reliably. The worker only learns
  // of the press once it has woken and restored its state, so a release inside
  // that gap looked older than the press, and the panel then sat on screen
  // waiting for a keyup that had already happened.
  let modifierDown = null;
  function trackModifiers(e) {
    modifierDown = e.ctrlKey || e.altKey || e.metaKey;
  }
  // Window capture from document_start, so this runs ahead of any listener the
  // page adds and a page swallowing key events can't blind it.
  window.addEventListener('keydown', trackModifiers, true);
  window.addEventListener('keyup', trackModifiers, true);
  window.addEventListener('blur', () => {
    modifierDown = null;
  });

  // Sub-frames draw nothing. They run at all because keyboard events go to the
  // frame that has focus, so whenever focus sits inside an iframe the top
  // document never sees the release and the panel would hang on screen until
  // clicked. This forwards that release instead.
  if (window.top !== window) {
    let cycleActive = false;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'show') {
        debugMode = !!msg.debug;
        // With focus in this frame the top frame hears nothing, so a release
        // that beat 'show' here is one only this frame knows about.
        if (modifierDown === false) {
          dlog('show: released before the panel, forwarding');
          cycleActive = false;
          chrome.runtime.sendMessage({ type: 'confirm-switch' });
        } else {
          cycleActive = true;
        }
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
  // the tab strip. Each carries its own text colour: white on yellow or orange
  // is roughly 2:1 contrast, which at 10px is closer to decoration than text.
  // In dark mode Chrome switches its tab strip to the pale 300-weight tints, all
  // with dark text, so `dark` follows suit — otherwise a group would be one
  // colour in the strip and another on its card.
  const GROUP_COLORS = {
    grey: { bg: '#5F6368', fg: '#FFFFFF', dark: '#DADCE0' },
    blue: { bg: '#1A73E8', fg: '#FFFFFF', dark: '#8AB4F8' },
    red: { bg: '#D93025', fg: '#FFFFFF', dark: '#F28B82' },
    yellow: { bg: '#F9AB00', fg: '#202124', dark: '#FDD663' },
    green: { bg: '#1E8E3E', fg: '#FFFFFF', dark: '#81C995' },
    pink: { bg: '#D01884', fg: '#FFFFFF', dark: '#FF8BCB' },
    purple: { bg: '#9334E6', fg: '#FFFFFF', dark: '#C58AF9' },
    cyan: { bg: '#007B83', fg: '#FFFFFF', dark: '#78D9EC' },
    orange: { bg: '#FA903E', fg: '#202124', dark: '#FCAD70' },
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
      --panel-edge: rgba(0, 0, 0, 0.06);
      /* The ring does the work, so the fill stays faint. A heavier grey fill
         under a mid-grey ring read as a pressed button rather than a
         selection, and muddied the white page thumbnails it framed. */
      --card-active: rgba(0, 0, 0, 0.08);
      --card-active-ring: rgba(0, 0, 0, 0.42);
      --title: #1a1a1a;
      --title-active: #1a1a1a;
      --thumb-bg: #f4f5f7;
      --thumb-ring: rgba(0, 0, 0, 0.08);
      --favicon-blank: rgba(0, 0, 0, 0.12);
      --scrollbar: rgba(0, 0, 0, 0.25);

      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: grid;
      gap: ${GRID_GAP_PX}px;
      padding: ${PANEL_PADDING_PX}px;
      /* A window too short for every row scrolls inside the panel rather than
         pushing cards off-screen; setActive keeps the selection in view.
         border-box so the cap includes the padding — content-box let the
         panel run 20px past it and sit closer to the window edge than
         VIEWPORT_MARGIN_PX. */
      box-sizing: border-box;
      max-height: calc(100vh - ${2 * VIEWPORT_MARGIN_PX}px);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      /* scrollIntoView honours this, so a card scrolled into view keeps the
         panel's padding around it instead of landing flush against the
         rounded edge, where the corners clip it. */
      scroll-padding: ${PANEL_PADDING_PX}px;
      /* Where scrollbars are always drawn (Windows, or macOS with a mouse),
         the default grey trough cut a hard stripe through the glass. */
      scrollbar-width: thin;
      scrollbar-color: var(--scrollbar) transparent;
      background: var(--panel-bg);
      /* Concentric with the cards: outer radius = card radius + panel padding. */
      border-radius: 22px;
      /* The hairline gives the edge definition the soft shadow can't on its own,
         most of all over a dark page, where the shadow disappears. */
      box-shadow:
        inset 0 0 0 1px var(--panel-edge),
        0 24px 60px rgba(0, 0, 0, 0.35),
        0 2px 8px rgba(0, 0, 0, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      /* Without this macOS thickens text, most visibly the light titles on
         the dark glass, where 12px type starts to look bold. */
      -webkit-font-smoothing: antialiased;
      backdrop-filter: blur(24px) saturate(1.6);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      pointer-events: auto;
      /* It is chrome, not content: a click-drag or double-click on a title
         should never leave a text selection behind. */
      user-select: none;
      -webkit-user-select: none;
    }
    /* No entrance animation, deliberately. This is a keyboard shortcut used
       dozens of times an hour, and any motion between the press and the
       panel reads as the panel lagging behind the hand — the macOS app
       switcher and Raycast don't animate either. The pause before it appears
       (REVEAL_DELAY_MS) is a different thing: nothing is drawn during it, so
       there is nothing to watch move. */
    @media (prefers-color-scheme: dark) {
      .panel {
        --panel-bg: rgba(32, 33, 36, 0.88);
        --panel-edge: rgba(255, 255, 255, 0.10);
        /* Selection is a light tile rather than a lighter grey. The thumbnail
           covers most of a card, so a fill only shows in the thin frame and
           the title row — and next to mostly-white page thumbnails, a grey a
           few shades up from the panel (or a white ring hugging a white
           thumbnail) simply didn't register. A near-white tile does, with the
           title flipped dark to stay readable on it. No ring: the tile is the
           edge. */
        --card-active: rgba(255, 255, 255, 0.85);
        --card-active-ring: transparent;
        --title: #e8eaed;
        --title-active: #1a1a1a;
        --thumb-bg: #2a2b2e;
        --thumb-ring: rgba(255, 255, 255, 0.12);
        --favicon-blank: rgba(255, 255, 255, 0.20);
        --scrollbar: rgba(255, 255, 255, 0.25);
      }
    }
    /* macOS "Reduce transparency". The frosted look is the first thing that
       setting exists to turn off. */
    @media (prefers-reduced-transparency: reduce) {
      .panel {
        --panel-bg: rgb(250, 250, 250);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
    }
    @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
      .panel { --panel-bg: rgb(32, 33, 36); }
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
    .card--active .title {
      color: var(--title-active);
    }
    /* Windows High Contrast drops box-shadows, which is all the selection is
       drawn with; an outline in the system highlight colour survives it. */
    @media (forced-colors: active) {
      .card--active {
        outline: 2px solid Highlight;
        outline-offset: -2px;
      }
    }
    .thumb-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: 6px;
      overflow: hidden;
      background: var(--thumb-bg);
    }
    /* The edge is drawn over the screenshot rather than around it, so it
       reads as the image's own border: a white page keeps a defined edge
       against the white panel, and a dark one against the dark panel,
       without the 1px of grey a ring outside the image adds to every card. */
    .thumb-wrap::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px var(--thumb-ring);
      pointer-events: none;
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
      background: var(--group-bg);
      color: var(--group-fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @media (prefers-color-scheme: dark) {
      .group-badge {
        background: var(--group-bg-dark);
        color: #202124;
      }
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
      /* Matches the favicon beside it, so the row is exactly 16px tall in
         every font rather than whatever "normal" resolves to. */
      line-height: 16px;
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
  // Set when the panel went up on a tab we switched to from a browser page
  // (chrome://settings and the like), which runs no content script. A release
  // that happened there, before the switch, can never reach us — and in that
  // state the highlight is always the tab you are already on, so closing is
  // always the right answer. This is how long a hold with no further press is
  // given before we conclude the release already happened. Any sign the hold
  // continues (another press, pointer movement with the modifier down) clears
  // it and hands back to the ordinary keyup path.
  const LANDED_IDLE_MS = 900;
  let landedPending = false;
  // A quick tap is a whole gesture on its own: press, let go, and you are on
  // the previous tab. Drawing the panel for the few dozen milliseconds that
  // takes only flashes it, on the most common use of the shortcut there is.
  // So the panel is built at once — it has to exist to hear the release — but
  // stays hidden until the hold has outlasted this, the way the macOS app
  // switcher waits before it appears. A second press shows it immediately:
  // cycling has plainly begun. A landed panel waits for that kind of proof
  // outright, since its release may already have happened where no page could
  // see it; showing it anyway only put up a panel that then closed itself.
  const REVEAL_DELAY_MS = 120;
  let revealTimer = null;
  let watchdogId = null;
  let lastActivityAt = 0;

  let host = null;
  let shadow = null;
  let panelEl = null;
  let cardEls = [];
  let tabsData = [];
  let currentIndex = 0;
  // How far the pointer must travel before it may take the selection from the
  // keyboard. The panel often appears directly under a resting cursor, and any
  // threshold below "a deliberate move" means an accidental nudge decides which
  // tab you land on.
  const HOVER_ENGAGE_PX = 12;
  let hoverAnchorX = null;
  let hoverAnchorY = null;

  function img(className, src) {
    const el = document.createElement('img');
    el.className = className;
    el.src = src;
    el.alt = '';
    // Dragging a thumbnail would otherwise lift a ghost copy of it off the panel.
    el.draggable = false;
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
      const thumb = img('thumb', tab.thumbnail);
      // Decode now, while the panel is still hidden for REVEAL_DELAY_MS. An
      // image in a hidden subtree is otherwise left undecoded until it first
      // paints, so the panel would appear with empty plates that fill in a
      // frame or two later.
      thumb.decode().catch(() => {});
      wrap.appendChild(thumb);
    } else {
      // No screenshot yet (tab not visited since the worker started, or it's a
      // page we can't capture) — show the favicon centered on a blank plate.
      const blank = div('thumb thumb--blank');
      // Drawn at 32px, so it needs the 64px source on a 2x display.
      const icon = tab.favIconLarge || tab.favIconUrl;
      if (icon) blank.appendChild(img('thumb-fallback-icon', icon));
      wrap.appendChild(blank);
    }

    // Chrome allows unnamed groups; a nameless pill would say nothing, so only
    // titled groups get a badge.
    if (tab.group && tab.group.title) {
      const badge = div('group-badge');
      badge.textContent = tab.group.title;
      const colors = GROUP_COLORS[tab.group.color] || GROUP_COLORS.grey;
      // Both palettes ride along; the stylesheet picks one by colour scheme.
      badge.style.setProperty('--group-bg', colors.bg);
      badge.style.setProperty('--group-fg', colors.fg);
      badge.style.setProperty('--group-bg-dark', colors.dark);
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

  // Fit the grid to the window. At full size six columns need ~1180px, so any
  // narrower window — two side by side on a laptop, say — used to clip the
  // outer columns off both edges, the current tab included. Cards shrink first,
  // which keeps the one-or-two-row shape through moderately narrow windows;
  // only once they would fall below MIN_CARD_WIDTH_PX does a column go and the
  // tabs flow onto another row.
  function gridFor(count) {
    const available = window.innerWidth - 2 * (VIEWPORT_MARGIN_PX + PANEL_PADDING_PX);
    const widthAt = (cols) => Math.floor((available - (cols - 1) * GRID_GAP_PX) / cols);
    let columns = Math.min(Math.max(count, 1), MAX_COLUMNS);
    while (columns > 1 && widthAt(columns) < MIN_CARD_WIDTH_PX) columns--;
    return { columns, cardWidth: Math.max(1, Math.min(CARD_WIDTH_PX, widthAt(columns))) };
  }

  // Full rebuild — only on a new cycle or when the tab list itself changes.
  function buildPanel() {
    shadow.replaceChildren();

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const panel = div('panel');
    const { columns, cardWidth } = gridFor(tabsData.length);
    panel.style.gridTemplateColumns = `repeat(${columns}, ${cardWidth}px)`;

    cardEls = tabsData.map((tab, i) => {
      const card = buildCard(tab, i);
      panel.appendChild(card);
      return card;
    });

    panelEl = panel;
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
    // Only matters when the window is short enough for the grid to scroll.
    const active = cardEls[index];
    if (active && panelEl && panelEl.scrollHeight > panelEl.clientHeight) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function reveal() {
    clearTimeout(revealTimer);
    revealTimer = null;
    if (host) host.style.visibility = 'visible';
  }

  function resetHoverAnchor() {
    hoverAnchorX = null;
    hoverAnchorY = null;
  }

  function noteActivity() {
    lastActivityAt = Date.now();
    // A keyboard step takes the selection back. The pointer has to travel
    // HOVER_ENGAGE_PX again from wherever it now rests before it can claim it,
    // so a cursor parked over a card cannot quietly override the cycling.
    resetHoverAnchor();
    if (watchdogId === null) watchdogId = setInterval(checkWatchdog, WATCHDOG_TICK_MS);
  }

  // Whether a release can reach this page at all. document.hasFocus() says yes
  // whenever focus is anywhere inside it, child frames included, but some of
  // those can never run a content script to forward the keyup: a PDF, whose
  // viewer lives inside an <embed>, or another extension's iframe. From here
  // they are as deaf as the omnibox, and treating them as focused meant waiting
  // out MAX_PANEL_MS for a keyup that could never arrive.
  function canHearRelease() {
    if (!document.hasFocus()) return false;
    const el = document.activeElement;
    if (!el) return true;
    if (el.tagName === 'EMBED' || el.tagName === 'OBJECT') return false;
    return !(el.tagName === 'IFRAME' && el.src.startsWith('chrome-extension:'));
  }

  function checkWatchdog() {
    if (!host) {
      stopWatchdog();
      return;
    }
    const idle = Date.now() - lastActivityAt;

    if (landedPending && idle > LANDED_IDLE_MS) {
      dlog('watchdog: landed and idle, closing', { idle });
      dismiss(); // the highlight is the tab we are on; nothing to switch to
      return;
    }

    // Unfocused: the release is unobservable here, so waiting cannot resolve
    // anything. Commit rather than cancel — pressing the shortcut was a request
    // to switch, and honouring it beats discarding it. Each cycle step calls
    // noteActivity, so this only fires on a genuine pause.
    if (!canHearRelease() && idle > UNFOCUSED_IDLE_MS) {
      dlog('watchdog: unfocused and idle, committing', { idle });
      commit(currentIndex);
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
    clearTimeout(revealTimer);
    revealTimer = null;
    landedPending = false;
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
    panelEl = null;
    cardEls = [];
    resetHoverAnchor();
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
    commit(currentIndex);
  }

  // The two ways a cycle can end from inside the page. Both take the panel down
  // here rather than waiting for the background to answer — the teardown message
  // it broadcasts will arrive either way, and a panel that lingers for a round
  // trip after the modifier is released reads as lag.
  function commit(index) {
    chrome.runtime.sendMessage({ type: 'confirm-switch', index });
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
    if (!host) return;
    if (e.key === 'Escape') {
      dismiss();
      return;
    }
    // A key pressed with no modifier down means the hold is over — the user has
    // moved on to typing. Only meaningful while landed: otherwise the modifier's
    // own keyup has already ended the cycle before any such key could arrive.
    if (landedPending && !MODIFIER_KEYS.includes(e.key) && !(e.ctrlKey || e.altKey || e.metaKey)) {
      dismiss();
    }
  }

  // Mouse and wheel events carry the live modifier state, so while landed they
  // settle the question the missing keyup could not — the moment the user
  // touches the mouse or scrolls, rather than after the idle fallback.
  function onLandedPointer(e) {
    if (!host || !landedPending) return;
    if (e.ctrlKey || e.altKey || e.metaKey) {
      // Still held, and this page is receiving events: the release will arrive
      // as an ordinary keyup, so stop second-guessing it.
      landedPending = false;
      reveal();
      return;
    }
    dlog('landed: pointer shows no modifier held, closing');
    dismiss();
  }

  function cardIndexFromEvent(e) {
    const card = e.target.closest('.card');
    return card ? Number(card.dataset.index) : -1;
  }

  function onCardHover(e) {
    // mousemove rather than mouseover, because mouseover also fires when a new
    // element lands under a stationary cursor. That alone was not enough: a
    // single pixel of drift counted as movement, so a cursor that merely
    // happened to sit over a card took the highlight, and releasing the
    // modifier then switched to that tab instead of the cycled one.
    //
    // The pointer now has to travel a real distance from where it was when the
    // keyboard last acted. Below that it is treated as resting, however much it
    // jitters.
    if (hoverAnchorX === null) {
      hoverAnchorX = e.clientX;
      hoverAnchorY = e.clientY;
      return;
    }

    const dx = e.clientX - hoverAnchorX;
    const dy = e.clientY - hoverAnchorY;
    if (dx * dx + dy * dy < HOVER_ENGAGE_PX * HOVER_ENGAGE_PX) return;

    const idx = cardIndexFromEvent(e);
    if (idx === -1 || idx === currentIndex) return;
    setActive(idx);
  }

  function onCardClick(e) {
    const idx = cardIndexFromEvent(e);
    if (idx === -1) return;
    commit(idx);
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
    commit(idx);
  }

  function sameTabList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
    }
    return true;
  }

  // What every reply to the background carries. tryShowOverlay inspects it to
  // decide whether the panel really painted, and startCycle reads released and
  // releasedAt to spot a hold that ended before we got here.
  function panelState() {
    return {
      ok: true,
      painted: !!host,
      // Whether a keyup can reach us; the background expires the cycle sooner
      // when it can't.
      focused: canHearRelease(),
      releasedAt: lastReleaseAt,
      // The modifier is already up, so no keyup is coming to close the panel.
      released: modifierDown === false,
    };
  }

  function showOverlay(tabs, index, debug, landed) {
    debugMode = !!debug;
    // Only a fresh panel can be landed; a rebuild mid-cycle (a tab closed)
    // keeps whatever state the cycle is already in.
    if (!host) landedPending = !!landed;
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

    const fresh = !host;
    if (fresh) {
      host = document.createElement('div');
      host.id = 'mru-tab-switcher-host';
      // pointer-events: none so the full-viewport host never blocks the page;
      // the panel itself re-enables them so cards stay hoverable and clickable.
      // Hidden until reveal() — see REVEAL_DELAY_MS. visibility rather than
      // opacity, so a click meanwhile falls through to the page and ends the
      // cycle like any other click outside the panel.
      host.style.cssText =
        'all: initial; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; pointer-events: none; visibility: hidden;';
      document.documentElement.appendChild(host);
      // Closed, so nothing else on the page can reach in. Dark Reader walks
      // every *open* shadow root it can find via element.shadowRoot and injects
      // its own stylesheets, rewriting colours — it turned the panel dark and
      // the selection near-black on top of it, invisible. It has no per-element
      // opt-out (only a page-wide lock we must never set), but a closed root
      // makes element.shadowRoot return null, and we never need it: `shadow`
      // is our handle. This also keeps out any other extension or page script
      // that restyles what it can see.
      shadow = host.attachShadow({ mode: 'closed' });
      // Shadow-scoped listeners die with the shadow root, so these belong here.
      shadow.addEventListener('mousemove', onCardHover);
      shadow.addEventListener('click', onCardClick);
      shadow.addEventListener('contextmenu', onCardContextMenu);
    }

    buildPanel();
    if (fresh && !landedPending) revealTimer = setTimeout(reveal, REVEAL_DELAY_MS);
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
  document.addEventListener('mousemove', onLandedPointer, { capture: true, passive: true });
  document.addEventListener('wheel', onLandedPointer, { capture: true, passive: true });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Report back whether the panel actually painted. A resolved sendMessage
    // only proves something was listening, so without this an overlay that
    // threw while building would still be reported as shown.
    try {
      if (msg.type === 'show') {
        showOverlay(msg.tabs, msg.index, msg.debug, msg.landed);
        sendResponse(panelState());
      } else if (msg.type === 'update') {
        // No panel means the page navigated since the cycle began, or the panel
        // already came down. painted: false in the reply tells the background to
        // start over rather than advance a highlight nobody can see.
        if (host) {
          // Another press proves the modifier is still held, and this page has
          // focus to hear its release.
          landedPending = false;
          noteActivity();
          setActive(msg.index);
          reveal();
        }
        sendResponse(panelState());
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
