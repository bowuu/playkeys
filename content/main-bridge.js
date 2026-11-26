/**
 * Playkeys - Main World Bridge Script (Runs in page execution context)
 * Directly interfaces with Plex's window.navigator.mediaSession,
 * intercepts MediaSession action handlers, extracts rich metadata,
 * and communicates bidirectionally with the isolated content script via window.postMessage.
 */

(() => {
  const BRIDGE_VERSION = 10;

  if (window.__PLAYKEYS_MAIN_BRIDGE_VERSION__ === BRIDGE_VERSION && typeof window.__PLAYKEYS_MAIN_BRIDGE_CLEANUP__ === 'function') {
    return;
  }

  if (typeof window.__PLAYKEYS_MAIN_BRIDGE_CLEANUP__ === 'function') {
    try {
      window.__PLAYKEYS_MAIN_BRIDGE_CLEANUP__();
    } catch {
      // Ignore cleanup errors from prior version
    }
  }

  window.__PLAYKEYS_MAIN_BRIDGE_INITIALIZED__ = true;
  window.__PLAYKEYS_MAIN_BRIDGE_VERSION__ = BRIDGE_VERSION;

  // Preserve captured MediaSession handlers & Play Queue store across extension reloads
  const plexHandlers = (window.__PLAYKEYS_MEDIA_HANDLERS__ =
    window.__PLAYKEYS_MEDIA_HANDLERS__ || new Map());
  const queueStore = (window.__PLAYKEYS_QUEUE_STORE__ =
    window.__PLAYKEYS_QUEUE_STORE__ || {
      queue: null,
      lastQueueUrl: '',
      serverOrigin: '',
      token: ''
    });
  let lastReportedMeta = null;
  let queueRefreshTimer = null;

  /**
   * Hook window.navigator.mediaSession.setActionHandler once
   * so we can directly trigger Plex's internal React/Redux player handlers
   */
  if (
    window.navigator &&
    window.navigator.mediaSession &&
    !window.__PLAYKEYS_MEDIA_SESSION_HOOKED__
  ) {
    window.__PLAYKEYS_MEDIA_SESSION_HOOKED__ = true;
    const originalSetActionHandler = window.navigator.mediaSession.setActionHandler.bind(
      window.navigator.mediaSession
    );

    window.navigator.mediaSession.setActionHandler = function (action, handler) {
      if (typeof handler === 'function') {
        plexHandlers.set(action, handler);
      } else {
        plexHandlers.delete(action);
      }
      return originalSetActionHandler(action, handler);
    };
  }

  /**
   * Check if any media element on the page is actively playing
   */
  function hasPlayingMedia() {
    const list = document.querySelectorAll('video, audio');
    for (const m of list) {
      if (!m.paused && !m.ended && (m.readyState > 1 || m.currentTime > 0)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve audio/video codec and bitrate for the currently playing item
   */
  function getCurrentMediaQuality(titleHint = '') {
    try {
      const items = queueStore.queue?.items;
      if (Array.isArray(items) && items.length > 0) {
        const selectedId = queueStore.queue?.selectedItemID;
        let match = selectedId
          ? items.find((it) => Number(it.playQueueItemID) === Number(selectedId))
          : null;
        if (!match && titleHint) {
          const lower = titleHint.trim().toLowerCase();
          match = items.find((it) => (it.title || '').trim().toLowerCase() === lower);
        }
        if (match && (match.audioCodec || match.videoCodec || match.bitrate)) {
          return {
            audioCodec: match.audioCodec || '',
            videoCodec: match.videoCodec || '',
            bitrate: Number(match.bitrate) || 0
          };
        }
      }
    } catch {
      // Ignore lookup errors
    }
    return { audioCodec: '', videoCodec: '', bitrate: 0 };
  }

  /**
   * Extract high-fidelity metadata from page-context MediaSession
   */
  function inspectPageMetadata() {
    try {
      if (window.navigator && window.navigator.mediaSession && window.navigator.mediaSession.metadata) {
        const meta = window.navigator.mediaSession.metadata;
        let artworkUrl = '';
        if (meta.artwork && meta.artwork.length > 0) {
          artworkUrl = meta.artwork[meta.artwork.length - 1].src || '';
        }
        const quality = getCurrentMediaQuality(meta.title || '');
        return {
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          artworkUrl,
          audioCodec: quality.audioCodec,
          videoCodec: quality.videoCodec,
          bitrate: quality.bitrate
        };
      }
    } catch (err) {
      console.warn('[Playkeys Bridge] Error reading mediaSession metadata:', err);
    }
    return null;
  }

  /**
   * Report metadata changes (including clearing to null) to the isolated content script
   */
  function checkAndBroadcastMetadata() {
    const meta = inspectPageMetadata();
    if (!meta) {
      if (lastReportedMeta !== null) {
        lastReportedMeta = null;
        window.postMessage(
          {
            source: 'PLAYKEYS_PAGE_BRIDGE',
            type: 'METADATA_UPDATE',
            data: null
          },
          '*'
        );
      }
      return;
    }

    if (
      !lastReportedMeta ||
      lastReportedMeta.title !== meta.title ||
      lastReportedMeta.artist !== meta.artist ||
      lastReportedMeta.album !== meta.album ||
      lastReportedMeta.artworkUrl !== meta.artworkUrl ||
      lastReportedMeta.audioCodec !== meta.audioCodec ||
      lastReportedMeta.videoCodec !== meta.videoCodec ||
      lastReportedMeta.bitrate !== meta.bitrate
    ) {
      lastReportedMeta = meta;
      window.postMessage(
        {
          source: 'PLAYKEYS_PAGE_BRIDGE',
          type: 'METADATA_UPDATE',
          data: meta
        },
        '*'
      );
    }
  }

  // Periodic metadata check (Plex updates mediaSession when tracks start/change/stop)
  const metaTimerId = setInterval(checkAndBroadcastMetadata, 800);

  /**
   * Invoke a registered MediaSession action handler with standard details payload
   */
  function invokeHandler(actionName, extraDetails = {}) {
    const handler = plexHandlers.get(actionName);
    if (typeof handler !== 'function') return false;
    handler({ action: actionName, ...extraDetails });
    return true;
  }

  /**
   * Locate Plex Web's Radix star-rating widget elements in the player bar
   */
  function findRatingElements() {
    const container = document.querySelector('[class*="PlayerControlsMetadata-container"]');
    const ratingContainer = document.querySelector('[class*="PlayerControlsMetadata-ratingContainer"]');
    const sliderRoot = ratingContainer?.querySelector('[dir="ltr"][data-orientation="horizontal"]') || null;
    const sliderThumb = ratingContainer?.querySelector('[role="slider"]') || null;
    return { container, ratingContainer, sliderRoot, sliderThumb };
  }

  /**
   * Read the current 0..10 userRating from Plex Web's rating slider
   */
  function getCurrentRating() {
    const { sliderThumb } = findRatingElements();
    if (!sliderThumb) return null;
    const val = parseInt(sliderThumb.getAttribute('aria-valuenow'), 10);
    return Number.isFinite(val) ? val : 0;
  }

  let pointerCaptureSpoofDepth = 0;
  const spoofedCapturedPointers = new Set();
  const nativeSetPointerCapture = Element.prototype.setPointerCapture;
  const nativeReleasePointerCapture = Element.prototype.releasePointerCapture;
  const nativeHasPointerCapture = Element.prototype.hasPointerCapture;

  /**
   * Temporarily spoof Element.prototype pointer-capture methods in a ref-counted scope
   * so synthetic Radix/slider pointer drags work even when concurrent calls overlap.
   */
  async function withSpoofedPointerCapture(fn) {
    if (pointerCaptureSpoofDepth === 0) {
      Element.prototype.setPointerCapture = function (id) {
        spoofedCapturedPointers.add(id);
      };
      Element.prototype.releasePointerCapture = function (id) {
        spoofedCapturedPointers.delete(id);
      };
      Element.prototype.hasPointerCapture = function (id) {
        return spoofedCapturedPointers.has(id) || nativeHasPointerCapture.call(this, id);
      };
    }
    pointerCaptureSpoofDepth += 1;
    try {
      return await fn();
    } finally {
      pointerCaptureSpoofDepth = Math.max(0, pointerCaptureSpoofDepth - 1);
      if (pointerCaptureSpoofDepth === 0) {
        spoofedCapturedPointers.clear();
        Element.prototype.setPointerCapture = nativeSetPointerCapture;
        Element.prototype.releasePointerCapture = nativeReleasePointerCapture;
        Element.prototype.hasPointerCapture = nativeHasPointerCapture;
      }
    }
  }

  function buildPointerInit(clientX, clientY, buttons = 1) {
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons
    };
  }

  function buildMouseInit(clientX, clientY, buttons = 1) {
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons
    };
  }

  /**
   * Set Plex Web's 0..10 userRating via Radix Slider pointer coordinates or React fiber fallback
   */
  async function setRating(targetValue) {
    const clamped = Math.max(0, Math.min(10, Math.round(Number(targetValue) || 0)));
    const { container, sliderRoot, sliderThumb } = findRatingElements();
    if (!sliderRoot || !sliderThumb) return false;

    if (container) {
      container.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
      container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    }

    const rect = sliderRoot.getBoundingClientRect();
    if (rect.width > 0) {
      const clientX = rect.left + (clamped / 10) * rect.width;
      const clientY = rect.top + rect.height / 2;

      await withSpoofedPointerCapture(async () => {
        const common = buildPointerInit(clientX, clientY, 1);
        sliderRoot.dispatchEvent(new PointerEvent('pointerover', common));
        sliderRoot.dispatchEvent(new PointerEvent('pointerenter', { ...common, bubbles: false }));
        sliderRoot.dispatchEvent(new PointerEvent('pointerdown', common));
        sliderRoot.dispatchEvent(new PointerEvent('pointermove', common));

        // Let React flush the updated value before pointerup triggers onValueCommit
        await new Promise((r) => setTimeout(r, 35));

        sliderRoot.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0 }));
        sliderRoot.dispatchEvent(new MouseEvent('click', buildMouseInit(clientX, clientY, 0)));
      });

      if (getCurrentRating() === clamped) {
        return true;
      }
    }

    // Fallback: invoke Radix Slider React onValueChange / onValueCommit props directly
    const fiberKey = Object.keys(sliderRoot).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    let fiber = fiberKey ? sliderRoot[fiberKey] : null;
    let steps = 0;
    while (fiber && steps < 12) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props && typeof props.onValueChange === 'function') {
        props.onValueChange([clamped]);
        if (typeof props.onValueCommit === 'function') {
          props.onValueCommit([clamped]);
        }
        return true;
      }
      fiber = fiber.return;
      steps += 1;
    }

    return false;
  }

  let volumeChain = Promise.resolve(false);
  let queuedVolumeTarget = null;
  let volumeInFlight = false;

  /**
   * Execute a single serialized volume slider interaction on Plex Web
   */
  async function applyPlexVolumeStep(targetValue) {
    const target = Math.max(0, Math.min(1, parseFloat(targetValue) || 0));
    const targetPercent = Math.round(target * 100);
    const slider = document.querySelector(
      '[class*="PlayerControls-volumeSlider-"], [class*="VolumeSlider-slider-"]'
    );
    if (!slider) return false;

    if (target > 0) {
      const volBtn = document.querySelector('button[class*="PlayerControls-volumeButton-"]');
      if (volBtn && /unmute/i.test(volBtn.getAttribute('aria-label') || '')) {
        volBtn.click();
      }
    }

    const thumb = slider.querySelector('[role="slider"]');
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const isVertical =
      slider.className.includes('VerticalSlider') || rect.height > rect.width;
    const clientX = isVertical
      ? rect.left + rect.width / 2
      : rect.left + target * rect.width;
    let clientY = isVertical
      ? rect.bottom - target * rect.height
      : rect.top + rect.height / 2;

    if (isVertical && target > 0 && target < 1 && rect.height > 2) {
      clientY = Math.max(rect.top + 0.5, Math.min(rect.bottom - 0.5, clientY));
    }

    await withSpoofedPointerCapture(async () => {
      const ptrDown = buildPointerInit(clientX, clientY, 1);
      const mouseDown = buildMouseInit(clientX, clientY, 1);

      slider.dispatchEvent(new PointerEvent('pointerover', ptrDown));
      slider.dispatchEvent(new PointerEvent('pointerenter', { ...ptrDown, bubbles: false }));
      slider.dispatchEvent(new MouseEvent('mouseover', mouseDown));
      slider.dispatchEvent(new MouseEvent('mouseenter', { ...mouseDown, bubbles: false }));
      slider.dispatchEvent(new PointerEvent('pointerdown', ptrDown));
      slider.dispatchEvent(new MouseEvent('mousedown', mouseDown));

      await new Promise((r) => setTimeout(r, 20));

      slider.dispatchEvent(new PointerEvent('pointermove', ptrDown));
      slider.dispatchEvent(new MouseEvent('mousemove', mouseDown));
      slider.dispatchEvent(new PointerEvent('pointerup', { ...ptrDown, buttons: 0 }));
      slider.dispatchEvent(new MouseEvent('mouseup', { ...mouseDown, buttons: 0 }));
    });

    await new Promise((r) => setTimeout(r, 25));

    if (thumb) {
      const nowVal = parseInt(thumb.getAttribute('aria-valuenow'), 10);
      if (
        Number.isFinite(nowVal) &&
        !(targetPercent > 0 && nowVal === 0) &&
        Math.abs(nowVal - targetPercent) <= 5
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Coalesce rapid drag calls so mousedown/mouseup always pair cleanly without queuing stale steps
   */
  function setPlexVolume(targetValue) {
    queuedVolumeTarget = targetValue;
    if (volumeInFlight) {
      return volumeChain;
    }

    volumeInFlight = true;
    volumeChain = (async () => {
      let lastResult = false;
      try {
        while (queuedVolumeTarget !== null) {
          const next = queuedVolumeTarget;
          queuedVolumeTarget = null;
          lastResult = await applyPlexVolumeStep(next);
        }
      } finally {
        volumeInFlight = false;
      }
      return lastResult;
    })();

    return volumeChain;
  }

  /**
   * Build thumbnail URL for Play Queue items using captured Plex server origin & token
   */
  function buildQueueArtworkUrl(thumbPath, serverOrigin, token) {
    if (!thumbPath) return '';
    if (/^https?:\/\//i.test(thumbPath)) return thumbPath;
    if (!serverOrigin) return '';
    if (token) {
      return `${serverOrigin}/photo/:/transcode?width=96&height=96&minSize=1&upscale=1&url=${encodeURIComponent(thumbPath)}&X-Plex-Token=${encodeURIComponent(token)}`;
    }
    return `${serverOrigin}${thumbPath}`;
  }

  function broadcastQueueUpdate() {
    window.postMessage(
      {
        source: 'PLAYKEYS_PAGE_BRIDGE',
        type: 'QUEUE_UPDATE',
        data: queueStore.queue
      },
      '*'
    );
    checkAndBroadcastMetadata();
  }

  /**
   * Normalize Plex MediaContainer /playQueues JSON into Playkeys queue state
   */
  function normalizeMediaContainerQueue(mc, serverOrigin, token) {
    const metadataList = Array.isArray(mc.Metadata) ? mc.Metadata : [];
    const items = metadataList.map((item) => {
      const thumbPath = item.thumb || item.parentThumb || item.grandparentThumb || '';
      const media0 = Array.isArray(item.Media) ? item.Media[0] : null;
      const part0 = Array.isArray(media0?.Part) ? media0.Part[0] : null;
      const audioStream = Array.isArray(part0?.Stream)
        ? part0.Stream.find((s) => Number(s.streamType) === 2)
        : null;
      let bitrate = Number(media0?.bitrate) || Number(audioStream?.bitrate) || 0;
      if (!bitrate && part0?.size) {
        const durationMs = Number(item.duration) || Number(media0?.duration) || 0;
        if (durationMs > 0) {
          bitrate = Math.round((Number(part0.size) * 8) / durationMs);
        }
      }
      return {
        playQueueItemID: Number(item.playQueueItemID) || null,
        ratingKey: item.ratingKey ? String(item.ratingKey) : '',
        parentRatingKey: item.parentRatingKey ? String(item.parentRatingKey) : '',
        title: item.title || 'Unknown Track',
        artist: item.originalTitle || item.grandparentTitle || '',
        album: item.parentTitle || '',
        duration: Math.round((Number(item.duration) || 0) / 1000),
        artworkUrl: buildQueueArtworkUrl(thumbPath, serverOrigin, token),
        audioCodec: media0?.audioCodec ? String(media0.audioCodec).toUpperCase() : '',
        videoCodec: media0?.videoCodec ? String(media0.videoCodec).toUpperCase() : '',
        bitrate
      };
    });

    return {
      playQueueID: Number(mc.playQueueID) || null,
      playQueueTitle: mc.playQueuePlaylistTitle || 'Play Queue',
      totalCount: Number(mc.playQueueTotalCount ?? mc.size ?? items.length) || items.length,
      selectedItemID: Number(mc.playQueueSelectedItemID) || null,
      selectedOffset: Number(mc.playQueueSelectedItemOffset) || 0,
      shuffled: Boolean(mc.playQueueShuffled),
      items
    };
  }

  let pendingQueueSelection = null;

  function applyPendingSelection(queue) {
    if (!queue || !pendingQueueSelection) return queue;
    if (Date.now() >= pendingQueueSelection.expiresAt) {
      pendingQueueSelection = null;
      return queue;
    }
    if (Number(queue.selectedItemID) === Number(pendingQueueSelection.itemId)) {
      pendingQueueSelection = null;
      return queue;
    }
    const idx = Array.isArray(queue.items)
      ? queue.items.findIndex((it) => Number(it.playQueueItemID) === Number(pendingQueueSelection.itemId))
      : -1;
    queue.selectedItemID = pendingQueueSelection.itemId;
    if (idx !== -1) queue.selectedOffset = idx;
    return queue;
  }

  async function fetchPlayQueueFromStoredUrl() {
    if (!queueStore.lastQueueUrl) return null;
    try {
      const fetchFn = window.__PLAYKEYS_ORIG_FETCH__ || window.fetch;
      const res = await fetchFn(queueStore.lastQueueUrl, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.MediaContainer) {
        const parsedUrl = new URL(queueStore.lastQueueUrl);
        const token = parsedUrl.searchParams.get('X-Plex-Token') || queueStore.token;
        const normalized = applyPendingSelection(
          normalizeMediaContainerQueue(data.MediaContainer, parsedUrl.origin, token)
        );
        const reduxQueue = buildQueueFromRedux();
        if (
          reduxQueue?.selectedItemID &&
          normalized.selectedItemID !== reduxQueue.selectedItemID &&
          normalized.items.some((it) => Number(it.playQueueItemID) === Number(reduxQueue.selectedItemID))
        ) {
          normalized.selectedItemID = reduxQueue.selectedItemID;
          normalized.selectedOffset = reduxQueue.selectedOffset;
        }
        queueStore.queue = normalized;
        broadcastQueueUpdate();
        return queueStore.queue;
      }
    } catch {
      // Ignore transient network errors
    }
    return null;
  }

  function scheduleQueueRefresh(delayMs = 350) {
    clearTimeout(queueRefreshTimer);
    queueRefreshTimer = setTimeout(async () => {
      const fetched = await fetchPlayQueueFromStoredUrl();
      if (!fetched) {
        const reduxQueue = buildQueueFromRedux();
        if (reduxQueue) {
          queueStore.queue = reduxQueue;
          broadcastQueueUpdate();
        }
      }
    }, delayMs);
  }

  function handleCapturedNetworkPayload(urlStr, data) {
    if (!urlStr) return;
    let parsed;
    try {
      parsed = new URL(urlStr, window.location.origin);
    } catch {
      return;
    }

    const tokenParam = parsed.searchParams.get('X-Plex-Token');
    if (tokenParam) {
      queueStore.serverOrigin = parsed.origin;
      queueStore.token = tokenParam;
    }

    if (/\/playQueues(\/|\?|$)/i.test(parsed.pathname) && data?.MediaContainer) {
      if (/\/playQueues\/\d+/i.test(parsed.pathname)) {
        queueStore.lastQueueUrl = parsed.toString();
      } else if (data.MediaContainer.playQueueID && queueStore.token) {
        queueStore.lastQueueUrl = `${parsed.origin}/playQueues/${data.MediaContainer.playQueueID}?own=1&X-Plex-Token=${encodeURIComponent(queueStore.token)}`;
      }
      queueStore.queue = applyPendingSelection(
        normalizeMediaContainerQueue(
          data.MediaContainer,
          parsed.origin,
          queueStore.token
        )
      );
      broadcastQueueUpdate();
      return;
    }

    if (/\/:\/timeline/i.test(parsed.pathname)) {
      const pqItemId = Number(parsed.searchParams.get('playQueueItemID'));
      const containerKey = parsed.searchParams.get('containerKey') || '';
      const pqMatch = /\/playQueues\/(\d+)/i.exec(containerKey);
      if (pqMatch && !queueStore.lastQueueUrl && queueStore.token) {
        queueStore.lastQueueUrl = `${parsed.origin}/playQueues/${pqMatch[1]}?own=1&X-Plex-Token=${encodeURIComponent(queueStore.token)}`;
        scheduleQueueRefresh(100);
      }

      if (queueStore.queue && Number.isFinite(pqItemId) && pqItemId > 0) {
        if (pendingQueueSelection && Date.now() < pendingQueueSelection.expiresAt) {
          if (pqItemId === pendingQueueSelection.itemId) {
            pendingQueueSelection = null;
          } else {
            return;
          }
        }
        if (queueStore.queue.selectedItemID !== pqItemId) {
          queueStore.queue.selectedItemID = pqItemId;
          const idx = queueStore.queue.items.findIndex((it) => it.playQueueItemID === pqItemId);
          if (idx !== -1) {
            queueStore.queue.selectedOffset = idx;
          }
          broadcastQueueUpdate();
          scheduleQueueRefresh(350);
        }
      }
    }
  }

  window.__PLAYKEYS_ON_NET_PAYLOAD__ = handleCapturedNetworkPayload;

  if (!window.__PLAYKEYS_NET_HOOKED__) {
    window.__PLAYKEYS_NET_HOOKED__ = true;

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.__PLAYKEYS_ORIG_FETCH__ = origFetch;
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const reqUrl =
            typeof args[0] === 'string'
              ? args[0]
              : args[0]?.url || args[0]?.href || '';
          if (res.ok && /\/playQueues(\/|\?|$)/i.test(reqUrl)) {
            res
              .clone()
              .json()
              .then((data) => window.__PLAYKEYS_ON_NET_PAYLOAD__?.(reqUrl, data))
              .catch(() => {});
          } else if (/\/:\/timeline/i.test(reqUrl)) {
            window.__PLAYKEYS_ON_NET_PAYLOAD__?.(reqUrl, null);
          }
        } catch {
          // Never interfere with app fetch
        }
        return res;
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__playkeysReqUrl = typeof url === 'string' ? url : String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const reqUrl = this.__playkeysReqUrl || '';
      if (!this.__playkeysHooked && (/\/playQueues(\/|\?|$)/i.test(reqUrl) || /\/:\/timeline/i.test(reqUrl))) {
        this.__playkeysHooked = true;
        this.addEventListener('load', function () {
          try {
            if (/\/playQueues(\/|\?|$)/i.test(reqUrl)) {
              let data = null;
              if (this.responseType === 'json' && this.response) {
                data = this.response;
              } else if (
                (this.responseType === '' || this.responseType === 'text') &&
                typeof this.responseText === 'string' &&
                this.responseText.trim().startsWith('{')
              ) {
                data = JSON.parse(this.responseText);
              }
              if (data) {
                window.__PLAYKEYS_ON_NET_PAYLOAD__?.(reqUrl, data);
              }
            } else if (/\/:\/timeline/i.test(reqUrl)) {
              window.__PLAYKEYS_ON_NET_PAYLOAD__?.(reqUrl, null);
            }
          } catch {
            // Ignore parse errors
          }
        });
      }
      return origSend.apply(this, args);
    };
  }

  /**
   * Locate Play Queue DOM controls and rendered item rows
   */
  function findPlayQueueScroller() {
    return document.querySelector('[class*="AudioVideoPlayQueue-content-"]');
  }

  function findButtonByA11yLabel(pattern, scope = document) {
    const buttons = scope.querySelectorAll('button');
    for (const btn of buttons) {
      const label = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('title') ||
        btn.getAttribute('aria-description') ||
        btn.textContent ||
        ''
      ).trim();
      if (pattern.test(label)) {
        return btn;
      }
    }
    return null;
  }

  function findPlayQueueButton() {
    const explicit = document.querySelector(
      'button[aria-label="Play Queue"], button[title="Play Queue"], button[aria-description="Play Queue"], button[class*="playQueue" i]'
    );
    if (explicit) return explicit;

    const volBtn = document.querySelector('button[class*="PlayerControls-volumeButton-"]');
    if (volBtn) {
      const directPrev = volBtn.previousElementSibling;
      if (directPrev && directPrev.tagName === 'BUTTON') return directPrev;
      const wrapperPrev = volBtn.parentElement?.previousElementSibling;
      if (wrapperPrev) {
        if (wrapperPrev.tagName === 'BUTTON') return wrapperPrev;
        const nestedBtn = wrapperPrev.querySelector('button');
        if (nestedBtn) return nestedBtn;
      }
    }

    const playerScope =
      document.querySelector('[class*="PlayerContainer-"], [class*="PlayerControls-"]') || document;
    return findButtonByA11yLabel(/^play queue$/i, playerScope);
  }

  function findMinimizePlayerButton() {
    const explicit = document.querySelector(
      'button[aria-label="Minimize Player"], button[title="Minimize Player"], button[aria-description="Minimize Player"], button[class*="minimize" i]'
    );
    if (explicit) return explicit;

    return findButtonByA11yLabel(/^minimize player$/i, document);
  }

  function dispatchRealClick(targetEl) {
    if (!targetEl) return false;
    const rect = targetEl.getBoundingClientRect();
    const clientX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
    const clientY = rect.height > 0 ? rect.top + rect.height / 2 : 0;

    const ptrInit = buildPointerInit(clientX, clientY, 1);
    const mouseInit = buildMouseInit(clientX, clientY, 1);

    targetEl.dispatchEvent(new PointerEvent('pointerover', ptrInit));
    targetEl.dispatchEvent(new PointerEvent('pointerenter', { ...ptrInit, bubbles: false }));
    targetEl.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    targetEl.dispatchEvent(new MouseEvent('mouseenter', { ...mouseInit, bubbles: false }));
    targetEl.dispatchEvent(new PointerEvent('pointerdown', ptrInit));
    targetEl.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    targetEl.dispatchEvent(new PointerEvent('pointerup', { ...ptrInit, buttons: 0 }));
    targetEl.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
    targetEl.click();
    return true;
  }

  function getRowPlayButton(row) {
    return row?.querySelector(
      'button[class*="MetadataPosterButtonCard-playButton-"], button[class*="PlayButton-playButton-"]'
    ) || null;
  }

  function getRenderedQueueRows() {
    const scroller = findPlayQueueScroller();
    if (!scroller) return [];

    const btns = Array.from(
      scroller.querySelectorAll(
        'button[class*="MetadataPosterButtonCard-playButton-"], button[class*="PlayButton-playButton-"]'
      )
    );

    const rows = [];
    const seen = new Set();
    for (const btn of btns) {
      let el = btn.parentElement;
      let steps = 0;
      while (el && el !== scroller && steps < 14) {
        if (el.querySelector('a')) {
          break;
        }
        el = el.parentElement;
        steps += 1;
      }
      const row = el && el !== scroller ? el : btn.parentElement;
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  function extractFiberItemFromElement(el, maxHops = 24) {
    if (!el) return null;
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    let fiber = fiberKey ? el[fiberKey] : null;
    let steps = 0;
    while (fiber && steps < maxHops) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const candidate =
        props?.item ||
        props?.playQueueItem ||
        props?.metadata ||
        props?.track ||
        props?.mediaItem ||
        props?.data;
      if (candidate && (candidate.playQueueItemID || candidate.ratingKey || candidate.title)) {
        return candidate;
      }
      fiber = fiber.return;
      steps += 1;
    }
    return null;
  }

  function extractFiberItem(row) {
    return (
      extractFiberItemFromElement(row, 24) ||
      extractFiberItemFromElement(getRowPlayButton(row), 24)
    );
  }

  function scrapePlayQueueFromDom() {
    const scroller = findPlayQueueScroller();
    if (!scroller) return null;
    const rows = getRenderedQueueRows();
    if (rows.length === 0) return null;

    let selectedItemID = null;
    let selectedOffset = 0;

    const items = rows.map((row, idx) => {
      const fiberItem = extractFiberItem(row);
      const links = Array.from(row.querySelectorAll('a'));
      const playBtn = getRowPlayButton(row);
      const img = row.querySelector('img');
      const removeBtn = row.querySelector('[class*="AudioVideoPlayQueueItem-removeButton-"]');

      const titleFromLabel = (playBtn?.getAttribute('aria-label') || '')
        .replace(/^Play\s+(Play\s+)?/i, '')
        .trim();
      const title = fiberItem?.title || links[0]?.textContent?.trim() || titleFromLabel || 'Unknown Track';
      const artist =
        fiberItem?.originalTitle ||
        fiberItem?.grandparentTitle ||
        links[1]?.textContent?.trim() ||
        '';
      const album = fiberItem?.parentTitle || links[2]?.textContent?.trim() || '';
      const durationMatch = /(\d+):(\d{2})/.exec(row.textContent || '');
      const durationFromText = durationMatch
        ? parseInt(durationMatch[1], 10) * 60 + parseInt(durationMatch[2], 10)
        : 0;
      const duration = fiberItem?.duration
        ? Math.round(Number(fiberItem.duration) / 1000)
        : durationFromText;

      const pqItemId = Number(fiberItem?.playQueueItemID) || -(idx + 1);
      if (!removeBtn && selectedItemID === null) {
        selectedItemID = pqItemId;
        selectedOffset = idx;
      }

      return {
        playQueueItemID: pqItemId,
        ratingKey: fiberItem?.ratingKey ? String(fiberItem.ratingKey) : '',
        parentRatingKey: fiberItem?.parentRatingKey ? String(fiberItem.parentRatingKey) : '',
        title,
        artist,
        album,
        duration,
        artworkUrl: img?.src || ''
      };
    });

    const headerText = document.querySelector('[class*="AudioVideoPlayQueue-"]')?.textContent || '';
    const countMatch = /(\d[\d,]*)\s+items?/i.exec(headerText);
    const totalCount = countMatch
      ? parseInt(countMatch[1].replace(/,/g, ''), 10)
      : items.length;

    return {
      playQueueID: queueStore.queue?.playQueueID || null,
      playQueueTitle: queueStore.queue?.playQueueTitle || 'Play Queue',
      totalCount,
      selectedItemID,
      selectedOffset,
      shuffled: queueStore.queue?.shuffled || false,
      items
    };
  }

  async function waitForQueueRows(timeoutMs = 600) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = getRenderedQueueRows();
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return getRenderedQueueRows();
  }

  let hiddenOverlayDepth = 0;

  /**
   * Temporarily hide Plex's full-screen player / Play Queue overlay while
   * performing a background DOM peek or item selection so the UI never flashes.
   */
  async function withHiddenPlayQueueOverlay(fn) {
    const styleId = 'playkeys-hide-queue-overlay';
    hiddenOverlayDepth += 1;
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      styleEl.textContent =
        '[class*="Player-fullPlayerContainer-"], [class*="AudioVideoPlayQueue-"] { opacity: 0 !important; pointer-events: none !important; transition: none !important; animation: none !important; }';
      (document.head || document.documentElement).appendChild(styleEl);
    }

    try {
      return await fn();
    } finally {
      // Allow Plex a brief moment to collapse the full-screen player before unhiding
      await new Promise((r) => setTimeout(r, 60));
      hiddenOverlayDepth = Math.max(0, hiddenOverlayDepth - 1);
      if (hiddenOverlayDepth === 0) {
        const el = document.getElementById(styleId);
        if (el) el.remove();
      }
    }
  }

  function buildQueueFromRedux() {
    try {
      const ctx = getPlexReduxContext();
      if (!ctx) return null;
      const state = ctx.store.getState();
      const avp = state?.ui?.audioVideoPlayer;
      const pq = avp?.playQueue;
      const pqItems = Array.isArray(pq?.playQueueItems) ? pq.playQueueItems : null;
      if (!pq || !pqItems || pqItems.length === 0) return null;

      const server = avp?.serverEntityID ? state?.entities?.servers?.[avp.serverEntityID] : null;
      const serverOrigin = server?.uri || queueStore.serverOrigin || '';
      const token = server?.accessToken || queueStore.token || '';
      if (serverOrigin) queueStore.serverOrigin = serverOrigin;
      if (token) queueStore.token = token;
      if (pq.playQueueID && serverOrigin && token && !queueStore.lastQueueUrl) {
        queueStore.lastQueueUrl = `${serverOrigin}/playQueues/${pq.playQueueID}?own=1&X-Plex-Token=${encodeURIComponent(token)}`;
      }

      const pqEntities = state?.entities?.playQueueItems || {};
      const metaEntities = state?.entities?.metadataItems || {};
      const mediaEntities = state?.entities?.media || {};
      const existingById = new Map();
      if (Array.isArray(queueStore.queue?.items)) {
        for (const prev of queueStore.queue.items) {
          if (prev?.playQueueItemID) existingById.set(Number(prev.playQueueItemID), prev);
        }
      }

      const items = pqItems
        .map((entityId) => {
          const pqRec = pqEntities[entityId];
          const meta = pqRec?.metadataItem ? metaEntities[pqRec.metadataItem] : null;
          if (!pqRec && !meta) return null;
          const thumbPath = meta?.thumb || meta?.parentThumb || meta?.grandparentThumb || '';
          const pqItemId = Number(pqRec?.playQueueItemID) || null;
          const prev = pqItemId ? existingById.get(pqItemId) : null;
          const mediaRef = Array.isArray(meta?.media) ? mediaEntities[meta.media[0]] : null;
          const mediaRaw = Array.isArray(meta?.Media) ? meta.Media[0] : null;
          const audioCodecRaw = mediaRef?.audioCodec || mediaRaw?.audioCodec || '';
          const videoCodecRaw = mediaRef?.videoCodec || mediaRaw?.videoCodec || '';
          const bitrateVal = Number(mediaRef?.bitrate || mediaRaw?.bitrate) || 0;
          return {
            playQueueItemID: pqItemId,
            ratingKey: meta?.ratingKey ? String(meta.ratingKey) : '',
            parentRatingKey: meta?.parentRatingKey ? String(meta.parentRatingKey) : '',
            title: meta?.title || 'Unknown Track',
            artist: meta?.originalTitle || meta?.grandparentTitle || '',
            album: meta?.parentTitle || '',
            duration: Math.round((Number(meta?.duration) || 0) / 1000),
            artworkUrl: buildQueueArtworkUrl(thumbPath, serverOrigin, token),
            audioCodec: audioCodecRaw ? String(audioCodecRaw).toUpperCase() : prev?.audioCodec || '',
            videoCodec: videoCodecRaw ? String(videoCodecRaw).toUpperCase() : prev?.videoCodec || '',
            bitrate: bitrateVal || prev?.bitrate || 0
          };
        })
        .filter(Boolean);

      if (items.length === 0) return null;

      return applyPendingSelection({
        playQueueID: Number(pq.playQueueID) || null,
        playQueueTitle: queueStore.queue?.playQueueTitle || 'Play Queue',
        totalCount: Number(pq.playQueueTotalCount ?? pq.length ?? items.length) || items.length,
        selectedItemID: Number(pq.playQueueSelectedItemID) || null,
        selectedOffset: Number(pq.playQueueSelectedItemOffset ?? pq.currentIndex) || 0,
        shuffled: Boolean(pq.playQueueShuffled),
        items
      });
    } catch {
      return null;
    }
  }

  async function refreshPlayQueue(allowDomPeek = false) {
    const reduxQueue = buildQueueFromRedux();

    if (queueStore.lastQueueUrl) {
      const fetched = await fetchPlayQueueFromStoredUrl();
      if (fetched) return fetched;
    }

    if (reduxQueue) {
      queueStore.queue = reduxQueue;
      broadcastQueueUpdate();
      return reduxQueue;
    }

    if (findPlayQueueScroller()) {
      const scraped = scrapePlayQueueFromDom();
      if (scraped) {
        queueStore.queue = scraped;
        broadcastQueueUpdate();
        return scraped;
      }
    }

    if (allowDomPeek) {
      const openBtn = findPlayQueueButton();
      if (openBtn) {
        const scraped = await withHiddenPlayQueueOverlay(async () => {
          dispatchRealClick(openBtn);
          await waitForQueueRows(700);
          const result = scrapePlayQueueFromDom();
          dispatchRealClick(findMinimizePlayerButton());
          return result;
        });
        if (scraped) {
          queueStore.queue = scraped;
          broadcastQueueUpdate();
          return scraped;
        }
      }
    }

    return queueStore.queue;
  }

  function matchRowInList(rows, payload, allowIndexFallback = true) {
    if (!rows || rows.length === 0) return null;

    // 1. Match by React fiber playQueueItemID
    if (payload.playQueueItemID && payload.playQueueItemID > 0) {
      for (const row of rows) {
        const fiberItem = extractFiberItem(row);
        if (fiberItem && Number(fiberItem.playQueueItemID) === Number(payload.playQueueItemID)) {
          return row;
        }
      }
    }

    // 2. Match by title + artist (then title-only fallback)
    if (payload.title) {
      const targetTitle = payload.title.trim().toLowerCase();
      const targetArtist = (payload.artist || '').trim().toLowerCase();
      let titleOnlyMatch = null;
      for (const row of rows) {
        const playBtn = getRowPlayButton(row);
        const label = (playBtn?.getAttribute('aria-label') || '')
          .replace(/^Play\s+(Play\s+)?/i, '')
          .trim()
          .toLowerCase();
        const firstLink = row.querySelector('a')?.textContent?.trim().toLowerCase() || '';
        const titleMatches = label === targetTitle || firstLink === targetTitle;
        if (!titleMatches) continue;
        if (!titleOnlyMatch) titleOnlyMatch = row;
        if (!targetArtist || (row.textContent || '').toLowerCase().includes(targetArtist)) {
          return row;
        }
      }
      if (titleOnlyMatch) {
        return titleOnlyMatch;
      }
    }

    // 3. Fallback by index only when caller explicitly permits positional matching
    if (
      allowIndexFallback &&
      Number.isInteger(payload.index) &&
      payload.index >= 0 &&
      payload.index < rows.length
    ) {
      return rows[payload.index];
    }

    return null;
  }

  async function findVirtualizedQueueRow(payload) {
    let rows = await waitForQueueRows(1000);
    if (!rows || rows.length === 0) return null;

    let matched = matchRowInList(rows, payload, false);
    if (matched) return matched;

    const scroller = findPlayQueueScroller();
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 20) {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const totalItems = queueStore.queue?.items?.length || 0;

      // Try jumping near the proportional offset first when the window index is known
      if (totalItems > 0 && Number.isInteger(payload.index) && payload.index >= 0) {
        const approxRatio = payload.index / Math.max(1, totalItems - 1);
        scroller.scrollTop = Math.round(maxScroll * approxRatio);
        await new Promise((r) => setTimeout(r, 70));
        rows = getRenderedQueueRows();
        matched = matchRowInList(rows, payload, false);
        if (matched) return matched;
      }

      // Sweep through the virtualized list from top to bottom
      const step = Math.max(180, Math.floor(scroller.clientHeight * 0.7));
      for (let pos = 0; pos <= maxScroll + step && pos <= maxScroll * 1.1; pos += step) {
        scroller.scrollTop = Math.min(maxScroll, pos);
        await new Promise((r) => setTimeout(r, 50));
        rows = getRenderedQueueRows();
        matched = matchRowInList(rows, payload, false);
        if (matched) return matched;
        if (pos >= maxScroll) break;
      }
    }

    // Last resort: check positional index on the top-most slice only if ID/title unavailable
    if (!payload.playQueueItemID && !payload.title) {
      return matchRowInList(getRenderedQueueRows(), payload, true);
    }
    return null;
  }

  function getPlexReduxContext() {
    const plexRoot = document.querySelector('#plex');
    const rootKey =
      plexRoot &&
      Object.keys(plexRoot).find(
        (k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')
      );
    if (!rootKey) return null;

    let store = null;
    const stack = [plexRoot[rootKey]];
    let steps = 0;
    while (stack.length > 0 && steps < 300) {
      const node = stack.pop();
      steps += 1;
      const p = node.memoizedProps;
      if (p && p.store && typeof p.store.getState === 'function' && typeof p.store.dispatch === 'function') {
        store = p.store;
        break;
      }
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    if (!store) return null;

    let playerType = 'audioVideo';
    const playerEl = document.querySelector('[class*="PlayerContainer-"]');
    const playerKey =
      playerEl &&
      Object.keys(playerEl).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance$')
      );
    if (playerKey) {
      const pStack = [playerEl[playerKey]];
      let pSteps = 0;
      while (pStack.length > 0 && pSteps < 80) {
        const node = pStack.pop();
        pSteps += 1;
        if (node.memoizedProps?.playerType) {
          playerType = node.memoizedProps.playerType;
          break;
        }
        if (node.child) pStack.push(node.child);
        if (node.sibling) pStack.push(node.sibling);
      }
    }

    return { store, playerType };
  }

  function playQueueItemViaRedux(payload) {
    try {
      const ctx = getPlexReduxContext();
      if (!ctx) return false;
      const { store, playerType } = ctx;
      const state = store.getState();
      const pq = state?.ui?.audioVideoPlayer?.playQueue;
      const pqItems = Array.isArray(pq?.playQueueItems) ? pq.playQueueItems : null;
      if (!pqItems || pqItems.length === 0) return false;

      const targetId = Number(payload.playQueueItemID);
      const pqEntities = state?.entities?.playQueueItems || {};
      const metaEntities = state?.entities?.metadataItems || {};
      let targetIndex = -1;

      // 1. Match by playQueueItemID against entity ID suffix or entity record
      if (Number.isFinite(targetId) && targetId > 0) {
        const idStr = String(targetId);
        const suffix = `--${idStr}`;
        targetIndex = pqItems.findIndex((entityId) => {
          if (typeof entityId !== 'string') return false;
          if (entityId.endsWith(suffix)) return true;
          const rec = pqEntities[entityId];
          return rec && String(rec.playQueueItemID) === idStr;
        });
      }

      // 2. Match by title + artist via Redux entities
      if (targetIndex === -1 && payload.title) {
        const targetTitle = payload.title.trim().toLowerCase();
        const targetArtist = (payload.artist || '').trim().toLowerCase();
        targetIndex = pqItems.findIndex((entityId) => {
          const pqRec = pqEntities[entityId];
          const meta = pqRec?.metadataItem ? metaEntities[pqRec.metadataItem] : null;
          if (!meta) return false;
          const title = (meta.title || '').trim().toLowerCase();
          if (title !== targetTitle) return false;
          if (!targetArtist) return true;
          const artist = (meta.originalTitle || meta.grandparentTitle || '').trim().toLowerCase();
          return artist === targetArtist || artist.includes(targetArtist);
        });
      }

      // 3. Positional fallback only when ID/title unavailable
      if (
        targetIndex === -1 &&
        (!Number.isFinite(targetId) || targetId <= 0) &&
        !payload.title &&
        Number.isInteger(payload.index) &&
        payload.index >= 0 &&
        payload.index < pqItems.length
      ) {
        targetIndex = payload.index;
      }

      if (targetIndex < 0 || targetIndex >= pqItems.length) {
        return false;
      }

      store.dispatch({
        type: 'ui/player/playQueue/playItemByIndex',
        payload: { playerType, index: targetIndex }
      });

      const resolvedEntityId = pqItems[targetIndex];
      const resolvedId =
        (Number.isFinite(targetId) && targetId > 0 && targetId) ||
        Number(pqEntities[resolvedEntityId]?.playQueueItemID) ||
        null;

      if (resolvedId) {
        pendingQueueSelection = {
          itemId: resolvedId,
          expiresAt: Date.now() + 1500
        };
      }

      if (queueStore.queue && resolvedId) {
        queueStore.queue.selectedItemID = resolvedId;
        queueStore.queue.selectedOffset = targetIndex;
        broadcastQueueUpdate();
      }
      scheduleQueueRefresh(250);
      return true;
    } catch (err) {
      console.warn('[Playkeys Bridge] Redux playQueueItem failed:', err);
      return false;
    }
  }

  async function playQueueItem(payload) {
    if (!payload) return false;

    if (playQueueItemViaRedux(payload)) {
      return true;
    }

    const wasClosed = !findPlayQueueScroller();

    const executeSelection = async () => {
      if (wasClosed) {
        const openBtn = findPlayQueueButton();
        if (!openBtn) {
          console.warn('[Playkeys Bridge] playQueueItem aborted: Play Queue button not found');
          return false;
        }
        dispatchRealClick(openBtn);
      }

      const matchedRow = await findVirtualizedQueueRow(payload);
      if (!matchedRow) {
        console.warn('[Playkeys Bridge] playQueueItem aborted: matching row not found', payload);
        if (wasClosed) dispatchRealClick(findMinimizePlayerButton());
        return false;
      }

      const targetPlayBtn = getRowPlayButton(matchedRow);
      if (!targetPlayBtn) {
        console.warn('[Playkeys Bridge] playQueueItem aborted: row play button not found');
        if (wasClosed) dispatchRealClick(findMinimizePlayerButton());
        return false;
      }

      const targetId = Number(payload.playQueueItemID) || null;
      const prevSelectedId = queueStore.queue?.selectedItemID || null;
      const prevTitle = window.navigator?.mediaSession?.metadata?.title || '';

      matchedRow.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 25));

      dispatchRealClick(targetPlayBtn);

      // Wait briefly for Plex's timeline/mediaSession/queue to register the switch before minimizing
      const confirmStart = Date.now();
      while (Date.now() - confirmStart < 450) {
        await new Promise((r) => setTimeout(r, 45));
        const curSelected = queueStore.queue?.selectedItemID || null;
        const curTitle = window.navigator?.mediaSession?.metadata?.title || '';
        if (
          (targetId && curSelected === targetId && curSelected !== prevSelectedId) ||
          (payload.title && curTitle && curTitle !== prevTitle && curTitle.toLowerCase() === payload.title.trim().toLowerCase())
        ) {
          break;
        }
      }

      if (wasClosed) {
        dispatchRealClick(findMinimizePlayerButton());
      }

      if (queueStore.queue && targetId) {
        queueStore.queue.selectedItemID = targetId;
        broadcastQueueUpdate();
      }
      scheduleQueueRefresh(350);
      return true;
    };

    return wasClosed ? withHiddenPlayQueueOverlay(executeSelection) : executeSelection();
  }

  /**
   * Listen for action dispatches from the isolated content script
   */
  const onMessage = async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'PLAYKEYS_CONTENT_SCRIPT') {
      return;
    }

    const { action, value, requestId } = event.data;
    let handled = false;
    let result = null;

    try {
      switch (action) {
        case 'playPause': {
          if (hasPlayingMedia()) {
            handled = invokeHandler('pause');
          } else {
            handled = invokeHandler('play');
          }
          break;
        }

        case 'play': {
          handled = invokeHandler('play');
          break;
        }

        case 'pause': {
          handled = invokeHandler('pause');
          break;
        }

        case 'next': {
          handled = invokeHandler('nexttrack');
          if (handled) setTimeout(checkAndBroadcastMetadata, 200);
          break;
        }

        case 'previous': {
          handled = invokeHandler('previoustrack');
          if (handled) setTimeout(checkAndBroadcastMetadata, 200);
          break;
        }

        case 'stop': {
          handled = invokeHandler('stop') || invokeHandler('pause');
          if (handled) setTimeout(checkAndBroadcastMetadata, 150);
          break;
        }

        case 'seek': {
          handled = invokeHandler('seekto', { seekTime: parseFloat(value) || 0 });
          break;
        }

        case 'setVolume': {
          handled = await setPlexVolume(value);
          break;
        }

        case 'setRating': {
          handled = await setRating(value);
          result = getCurrentRating();
          break;
        }

        case 'getRating': {
          result = getCurrentRating();
          handled = result !== null;
          break;
        }

        case 'getMetadata': {
          result = inspectPageMetadata();
          handled = true;
          break;
        }

        case 'getQueue': {
          result = queueStore.queue;
          handled = Boolean(result);
          break;
        }

        case 'refreshQueue': {
          result = await refreshPlayQueue(Boolean(value));
          handled = Boolean(result);
          break;
        }

        case 'playQueueItem': {
          handled = await playQueueItem(value);
          result = queueStore.queue;
          break;
        }
      }
    } catch (err) {
      console.warn('[Playkeys Bridge] Action execution notice:', action, err);
    }

    window.postMessage(
      {
        source: 'PLAYKEYS_PAGE_BRIDGE',
        type: 'ACTION_RESPONSE',
        bridgeVersion: BRIDGE_VERSION,
        requestId,
        handled,
        result
      },
      '*'
    );
  };

  window.addEventListener('message', onMessage);

  window.__PLAYKEYS_MAIN_BRIDGE_CLEANUP__ = () => {
    clearInterval(metaTimerId);
    clearTimeout(queueRefreshTimer);
    window.removeEventListener('message', onMessage);
  };

  // Initial metadata check
  checkAndBroadcastMetadata();
  console.log('[Playkeys Bridge] Page-context MediaSession bridge initialized (v' + BRIDGE_VERSION + ').');
})();
