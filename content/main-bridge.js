/**
 * Playkeys - Main World Bridge Script (Runs in page execution context)
 * Directly interfaces with Plex's window.navigator.mediaSession,
 * intercepts MediaSession action handlers, extracts rich metadata,
 * and communicates bidirectionally with the isolated content script via window.postMessage.
 */

(() => {
  if (window.__PLAYKEYS_MAIN_BRIDGE_INITIALIZED__) {
    return;
  }
  window.__PLAYKEYS_MAIN_BRIDGE_INITIALIZED__ = true;

  // Stored references to Plex's MediaSession action handlers
  const plexHandlers = new Map();
  let lastReportedMeta = null;

  /**
   * Hook window.navigator.mediaSession.setActionHandler
   * so we can directly trigger Plex's internal React/Redux player handlers
   */
  if (window.navigator && window.navigator.mediaSession) {
    const originalSetActionHandler = window.navigator.mediaSession.setActionHandler.bind(window.navigator.mediaSession);

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
        return {
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          artworkUrl
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
      lastReportedMeta.artworkUrl !== meta.artworkUrl
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
  setInterval(checkAndBroadcastMetadata, 800);

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

  /**
   * Set Plex Web's 0..10 userRating via Radix Slider pointer coordinates or React fiber fallback
   */
  function setRating(targetValue) {
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

      const origSetCapture = Element.prototype.setPointerCapture;
      const origReleaseCapture = Element.prototype.releasePointerCapture;
      const origHasCapture = Element.prototype.hasPointerCapture;
      Element.prototype.setPointerCapture = function () {};
      Element.prototype.releasePointerCapture = function () {};
      Element.prototype.hasPointerCapture = function () {
        return false;
      };

      try {
        const common = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1
        };
        sliderRoot.dispatchEvent(new PointerEvent('pointerover', common));
        sliderRoot.dispatchEvent(new PointerEvent('pointerenter', { ...common, bubbles: false }));
        sliderRoot.dispatchEvent(new PointerEvent('pointerdown', common));
        sliderRoot.dispatchEvent(new PointerEvent('pointermove', common));
        sliderRoot.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0 }));
        sliderRoot.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY,
            button: 0
          })
        );
      } finally {
        Element.prototype.setPointerCapture = origSetCapture;
        Element.prototype.releasePointerCapture = origReleaseCapture;
        Element.prototype.hasPointerCapture = origHasCapture;
      }

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

  /**
   * Listen for action dispatches from the isolated content script
   */
  window.addEventListener('message', (event) => {
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

        case 'setRating': {
          handled = setRating(value);
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
      }
    } catch (err) {
      console.warn('[Playkeys Bridge] Action execution notice:', action, err);
    }

    window.postMessage(
      {
        source: 'PLAYKEYS_PAGE_BRIDGE',
        type: 'ACTION_RESPONSE',
        requestId,
        handled,
        result
      },
      '*'
    );
  });

  // Initial metadata check
  checkAndBroadcastMetadata();
  console.log('[Playkeys Bridge] Page-context MediaSession bridge initialized.');
})();
