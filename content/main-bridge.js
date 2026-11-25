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
