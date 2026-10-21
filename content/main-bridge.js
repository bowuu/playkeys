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
          artworkUrl: artworkUrl
        };
      }
    } catch (err) {
      console.warn('[Playkeys Bridge] Error reading mediaSession metadata:', err);
    }
    return null;
  }

  /**
   * Report metadata changes to the isolated content script
   */
  function checkAndBroadcastMetadata() {
    const meta = inspectPageMetadata();
    if (!meta) return;

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

  // Periodic metadata check (Plex updates mediaSession when tracks start/change)
  setInterval(checkAndBroadcastMetadata, 800);

  /**
   * Listen for action dispatches from the isolated content script
   */
  window.addEventListener('message', (event) => {
    // Only accept messages from the same window and from Playkeys content script
    if (event.source !== window || !event.data || event.data.source !== 'PLAYKEYS_CONTENT_SCRIPT') {
      return;
    }

    const { action, value, requestId } = event.data;
    let handled = false;
    let result = null;

    try {
      switch (action) {
        case 'playPause': {
          // Check if pause handler is available and active media is playing
          const media = document.querySelector('video, audio');
          if (media && !media.paused && plexHandlers.has('pause')) {
            plexHandlers.get('pause')();
            handled = true;
          } else if (plexHandlers.has('play')) {
            plexHandlers.get('play')();
            handled = true;
          }
          break;
        }

        case 'play': {
          if (plexHandlers.has('play')) {
            plexHandlers.get('play')();
            handled = true;
          }
          break;
        }

        case 'pause': {
          if (plexHandlers.has('pause')) {
            plexHandlers.get('pause')();
            handled = true;
          }
          break;
        }

        case 'next': {
          if (plexHandlers.has('nexttrack')) {
            plexHandlers.get('nexttrack')();
            handled = true;
          }
          break;
        }

        case 'previous': {
          if (plexHandlers.has('previoustrack')) {
            plexHandlers.get('previoustrack')();
            handled = true;
          }
          break;
        }

        case 'stop': {
          if (plexHandlers.has('stop')) {
            plexHandlers.get('stop')();
            handled = true;
          } else if (plexHandlers.has('pause')) {
            plexHandlers.get('pause')();
            handled = true;
          }
          break;
        }

        case 'seek': {
          if (plexHandlers.has('seekto')) {
            plexHandlers.get('seekto')({ seekTime: parseFloat(value) || 0 });
            handled = true;
          }
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

    // Acknowledge back to content script
    window.postMessage(
      {
        source: 'PLAYKEYS_PAGE_BRIDGE',
        type: 'ACTION_RESPONSE',
        requestId: requestId,
        handled: handled,
        result: result
      },
      '*'
    );
  });

  // Initial metadata check
  checkAndBroadcastMetadata();
  console.log('[Playkeys Bridge] Page-context MediaSession bridge initialized.');
})();
