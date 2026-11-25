/**
 * Playkeys - Content Script (Manifest V3)
 * Resilient multi-tier player controller for Plex Web.
 * Operates in isolated world, coordinates with main-bridge.js,
 * inspects Plex Web DOM, and controls HTML5 media elements.
 */

(() => {
  if (window.__PLAYKEYS_CONTENT_INITIALIZED__) {
    return;
  }
  window.__PLAYKEYS_CONTENT_INITIALIZED__ = true;

  // Cached state & metadata
  let bridgeMetadata = null;
  let bridgeQueue = null;
  let lastBroadcastState = null;
  let attachedMediaElement = null;
  let attachedMediaHandler = null;
  let heartbeatTimer = null;
  let mutationDebounceTimer = null;
  let domObserver = null;

  const MEDIA_EVENTS = ['play', 'pause', 'timeupdate', 'volumechange', 'ended', 'loadedmetadata', 'seeked'];

  /**
   * Check whether the extension runtime context is still valid
   */
  function isExtensionContextValid() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
  }

  /**
   * Tear down timers, observers, and media listeners if extension reloads/unloads
   */
  function teardown() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    detachMediaListeners();
  }

  /**
   * Listen for messages from page-context main-bridge.js
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'PLAYKEYS_PAGE_BRIDGE') {
      return;
    }

    if (event.data.type === 'METADATA_UPDATE') {
      bridgeMetadata = event.data.data || null;
      broadcastState(true);
    } else if (event.data.type === 'QUEUE_UPDATE') {
      bridgeQueue = event.data.data || null;
      if (isExtensionContextValid()) {
        chrome.runtime
          .sendMessage({
            type: 'PLEX_QUEUE_UPDATE',
            queue: bridgeQueue
          })
          .catch(() => {});
      }
    }
  });

  /**
   * Dispatch action to main-bridge.js and resolve { handled, result }
   */
  function dispatchToBridgeWithResult(action, value = null, timeoutMs = 600) {
    return new Promise((resolve) => {
      const requestId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'req_' + Math.random().toString(36).slice(2, 11);

      let timeoutId = null;

      const responseHandler = (event) => {
        if (
          event.source === window &&
          event.data &&
          event.data.source === 'PLAYKEYS_PAGE_BRIDGE' &&
          event.data.type === 'ACTION_RESPONSE' &&
          event.data.requestId === requestId
        ) {
          // Ignore negative responses from an older pre-v2 bridge instance if still loaded
          if (!event.data.handled && !event.data.bridgeVersion) {
            return;
          }
          clearTimeout(timeoutId);
          window.removeEventListener('message', responseHandler);
          resolve({
            handled: Boolean(event.data.handled),
            result: event.data.result ?? null
          });
        }
      };

      window.addEventListener('message', responseHandler);

      window.postMessage(
        {
          source: 'PLAYKEYS_CONTENT_SCRIPT',
          action,
          value,
          requestId
        },
        '*'
      );

      timeoutId = setTimeout(() => {
        window.removeEventListener('message', responseHandler);
        resolve({ handled: false, result: null });
      }, timeoutMs);
    });
  }

  /**
   * Dispatch action to main-bridge.js
   */
  async function dispatchToBridge(action, value = null, timeoutMs = 600) {
    const res = await dispatchToBridgeWithResult(action, value, timeoutMs);
    return res.handled;
  }

  /**
   * Find active HTML5 audio or video element
   */
  function findActiveMediaElement() {
    const list = Array.from(document.querySelectorAll('video, audio'));
    if (!list.length) return null;

    // 1. Actively playing
    const playing = list.find((m) => !m.paused && m.currentTime > 0);
    if (playing) return playing;

    // 2. Ready media with duration
    const withDuration = list.find((m) => m.duration > 0 && isFinite(m.duration));
    if (withDuration) return withDuration;

    // 3. Media with valid src or readyState
    const activeSrc = list.find((m) => (m.src || m.currentSrc) && m.readyState > 0);
    if (activeSrc) return activeSrc;

    return list[0];
  }

  /**
   * Match control buttons in Plex Web with comprehensive selector patterns
   */
  function findButton(buttonType) {
    const selectorMatrix = {
      playPause: [
        'button[data-testid="playButton"]',
        'button[data-testid="pauseButton"]',
        'button[data-testid="resumeButton"]',
        'button[data-testid="playerPlayButton"]',
        'button[data-testid="playerPauseButton"]',
        'button[aria-label*="Play" i]',
        'button[aria-label*="Pause" i]',
        'button[aria-label*="Resume" i]',
        '[data-testid="player-play-button"]',
        '[data-testid="player-pause-button"]',
        '[class*="playButton"]',
        '[class*="pauseButton"]',
        '[class*="PlayerControls-playButton"]',
        '[class*="PlayerControls-pauseButton"]'
      ],
      play: [
        'button[data-testid="playButton"]',
        'button[data-testid="resumeButton"]',
        'button[data-testid="playerPlayButton"]',
        'button[aria-label*="Play" i]',
        'button[aria-label*="Resume" i]'
      ],
      pause: [
        'button[data-testid="pauseButton"]',
        'button[data-testid="playerPauseButton"]',
        'button[aria-label*="Pause" i]'
      ],
      next: [
        'button[data-testid="nextButton"]',
        'button[data-testid="playerNextButton"]',
        'button[aria-label*="Next" i]',
        'button[aria-label*="Skip Forward" i]',
        'button[aria-label*="Step Forward" i]',
        '[data-testid="player-next-button"]',
        '[class*="nextButton"]',
        '[class*="forwardButton"]',
        '[class*="PlayerControls-nextButton"]'
      ],
      previous: [
        'button[data-testid="previousButton"]',
        'button[data-testid="playerPreviousButton"]',
        'button[aria-label*="Previous" i]',
        'button[aria-label*="Skip Back" i]',
        'button[aria-label*="Step Back" i]',
        '[data-testid="player-previous-button"]',
        '[class*="previousButton"]',
        '[class*="backwardButton"]',
        '[class*="PlayerControls-previousButton"]'
      ],
      stop: [
        'button[data-testid="stopButton"]',
        'button[data-testid="playerStopButton"]',
        'button[aria-label*="Stop" i]',
        '[data-testid="player-stop-button"]',
        '[class*="PlayerControls-stopButton"]'
      ],
      shuffle: [
        'button[data-testid="shuffleButton"]',
        'button[data-testid="playerShuffleButton"]',
        'button[aria-label*="Shuffle" i]',
        '[class*="shuffleButton"]'
      ],
      repeat: [
        'button[data-testid="repeatButton"]',
        'button[data-testid="playerRepeatButton"]',
        'button[aria-label*="Repeat" i]',
        '[class*="repeatButton"]'
      ],
      mute: [
        'button[class*="PlayerControls-volumeButton-"]',
        'button[data-testid="volumeButton"]',
        'button[data-testid="playerVolumeButton"]',
        'button[aria-label*="Mute" i]',
        'button[aria-label*="Unmute" i]',
        '[data-testid="player-volume-button"]'
      ]
    };

    const selectors = selectorMatrix[buttonType] || [];
    for (const sel of selectors) {
      try {
        const matches = Array.from(document.querySelectorAll(sel));
        for (const el of matches) {
          if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
            return el;
          }
        }
      } catch {
        // Ignore unsupported selector
      }
    }
    return null;
  }

  /**
   * Dispatch full synthetic event sequence to trigger React's synthetic event listeners
   */
  function simulateClick(element) {
    if (!element) return false;
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new PointerEvent('pointerdown', opts));
      element.dispatchEvent(new MouseEvent('mousedown', opts));
      element.dispatchEvent(new PointerEvent('pointerup', opts));
      element.dispatchEvent(new MouseEvent('mouseup', opts));
      element.click();
      return true;
    } catch {
      try {
        element.click();
        return true;
      } catch (err) {
        console.warn('[Playkeys] Click failed:', err);
        return false;
      }
    }
  }

  /**
   * Extract comprehensive metadata from bridge or Plex Web DOM
   */
  function extractMetadata() {
    let title = '';
    let artist = '';
    let album = '';
    let artworkUrl = '';

    // 1. First priority: High-fidelity metadata from main-bridge (MediaSession)
    if (bridgeMetadata) {
      if (bridgeMetadata.title) title = bridgeMetadata.title.trim();
      if (bridgeMetadata.artist) artist = bridgeMetadata.artist.trim();
      if (bridgeMetadata.album) album = bridgeMetadata.album.trim();
      if (bridgeMetadata.artworkUrl) artworkUrl = bridgeMetadata.artworkUrl;
    }

    // 2. Second priority: Plex Web DOM Title selectors
    if (!title) {
      const titleSelectors = [
        '[data-testid="title"]',
        '[data-testid="metadataTitle"]',
        '[data-testid="item-title"]',
        '[data-testid="playerMediaTitle"]',
        '[data-testid="playerTitle"]',
        'a[data-testid="playerTitle"]',
        '[class*="ItemTitle-title"]',
        '[class*="PlayerTitle-title"]',
        '[class*="Metadata-title"]',
        '[class*="PlayerContainer"] [class*="itemTitle"]',
        '[class*="AudioPlayer"] [class*="title-"]'
      ];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          title = el.textContent.trim();
          break;
        }
      }
    }

    // 3. Second priority: Plex Web DOM Subtitle / Artist selectors
    if (!artist) {
      const subtitleSelectors = [
        '[data-testid="subtitle"]',
        '[data-testid="metadataSubtitle"]',
        '[data-testid="item-subtitle"]',
        '[data-testid="playerMediaSubtitle"]',
        '[data-testid="playerSubtitle"]',
        '[class*="ItemSubtitle-subtitle"]',
        '[class*="Metadata-subtitle"]',
        '[class*="PlayerContainer"] [class*="itemSubtitle"]',
        '[class*="AudioPlayer"] [class*="artist-"]',
        'a[class*="ArtistLink"]'
      ];
      for (const sel of subtitleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          artist = el.textContent.trim();
          break;
        }
      }
    }

    // 4. Album / Season
    if (!album) {
      const albumSelectors = [
        '[data-testid="itemGrandparentTitle"]',
        '[data-testid="grandparentTitle"]',
        '[data-testid="playerMediaGrandparentTitle"]',
        '[class*="grandparentTitle"]',
        '[class*="ItemGrandparentTitle"]'
      ];
      for (const sel of albumSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          album = el.textContent.trim();
          break;
        }
      }
    }

    // 5. Artwork / Poster
    if (!artworkUrl) {
      const imgSelectors = [
        '[data-testid="poster"] img',
        '[data-testid="artwork"] img',
        'img[data-testid="playerArtwork"]',
        '[data-testid="playerThumbnail"] img',
        '[class*="PlayerPoster"] img',
        '[class*="PosterCard-poster"] img',
        '[class*="MediaPoster"] img',
        '[class*="PlayerContainer"] img'
      ];
      for (const sel of imgSelectors) {
        const el = document.querySelector(sel);
        if (el && el.src && !el.src.includes('data:image/svg')) {
          artworkUrl = el.src;
          break;
        }
      }
    }

    return { title, artist, album, artworkUrl };
  }

  /**
   * Determine complete player state
   */
  function getPlayerState() {
    const media = findActiveMediaElement();
    const meta = extractMetadata();

    let isPlaying = false;
    let isPaused = true;
    let currentTime = 0;
    let duration = 0;
    let volume = 1;
    let isMuted = false;

    if (media) {
      isPlaying = !media.paused && !media.ended && (media.readyState > 1 || media.currentTime > 0);
      isPaused = media.paused;
      currentTime = media.currentTime || 0;
      duration = isFinite(media.duration) ? media.duration : 0;
      volume = media.volume;
      isMuted = media.muted;
    } else {
      // Check pause button presence in UI if media element is unmounted or detached
      const pauseBtn = findButton('pause');
      const playBtn = findButton('play');
      if (pauseBtn && (!playBtn || pauseBtn.offsetParent !== null)) {
        isPlaying = true;
        isPaused = false;
      }
    }

    // Check Shuffle State
    let isShuffle = false;
    const shuffleBtn = findButton('shuffle');
    if (shuffleBtn) {
      isShuffle = (
        shuffleBtn.getAttribute('aria-checked') === 'true' ||
        shuffleBtn.classList.contains('active') ||
        shuffleBtn.getAttribute('data-is-active') === 'true' ||
        shuffleBtn.className.includes('Active')
      );
    }

    // Check Repeat State
    let repeatMode = 'off';
    const repeatBtn = findButton('repeat');
    if (repeatBtn) {
      const ariaLabel = (repeatBtn.getAttribute('aria-label') || '').toLowerCase();
      const ariaChecked = repeatBtn.getAttribute('aria-checked');
      if (ariaChecked === 'true' || repeatBtn.className.includes('Active')) {
        repeatMode = ariaLabel.includes('one') ? 'one' : 'all';
      }
    }

    const hasMedia = !!(
      (media && (media.currentSrc || media.src || media.readyState > 0 || media.duration > 0)) ||
      meta.title ||
      isPlaying
    );

    // Check Plex Web star rating slider (0..10 scale)
    const ratingSlider = document.querySelector(
      '[class*="PlayerControlsMetadata-ratingContainer"] [role="slider"]'
    );
    const canRate = Boolean(ratingSlider);
    let userRating = null;
    if (ratingSlider) {
      const parsedRating = parseInt(ratingSlider.getAttribute('aria-valuenow'), 10);
      userRating = Number.isFinite(parsedRating) ? parsedRating : 0;
    }

    return {
      hasMedia,
      isPlaying,
      isPaused,
      currentTime,
      duration,
      volume,
      isMuted,
      isShuffle,
      repeatMode,
      canRate,
      userRating,
      title: meta.title || (isPlaying ? 'Plex Playback' : 'Idle'),
      artist: meta.artist || '',
      album: meta.album || '',
      artworkUrl: meta.artworkUrl || '',
      pageUrl: window.location.href,
      timestamp: Date.now()
    };
  }

  /**
   * Broadcast state to background worker and popup
   */
  function broadcastState(forced = false) {
    if (!isExtensionContextValid()) {
      teardown();
      return;
    }

    const state = getPlayerState();

    if (
      !forced &&
      lastBroadcastState &&
      lastBroadcastState.hasMedia === state.hasMedia &&
      lastBroadcastState.isPlaying === state.isPlaying &&
      lastBroadcastState.isPaused === state.isPaused &&
      lastBroadcastState.title === state.title &&
      lastBroadcastState.artist === state.artist &&
      lastBroadcastState.album === state.album &&
      lastBroadcastState.artworkUrl === state.artworkUrl &&
      lastBroadcastState.isShuffle === state.isShuffle &&
      lastBroadcastState.repeatMode === state.repeatMode &&
      lastBroadcastState.canRate === state.canRate &&
      lastBroadcastState.userRating === state.userRating &&
      lastBroadcastState.duration === state.duration &&
      Math.abs(lastBroadcastState.currentTime - state.currentTime) < 0.9 &&
      lastBroadcastState.isMuted === state.isMuted &&
      lastBroadcastState.volume === state.volume
    ) {
      return;
    }

    lastBroadcastState = state;

    try {
      chrome.runtime
        .sendMessage({
          type: 'PLEX_STATE_UPDATE',
          state
        })
        .catch(() => {
          // Background worker asleep; safe to ignore
        });
    } catch {
      teardown();
    }
  }

  /**
   * Detach listeners from previously attached media element
   */
  function detachMediaListeners() {
    if (attachedMediaElement && attachedMediaHandler) {
      MEDIA_EVENTS.forEach((evt) => attachedMediaElement.removeEventListener(evt, attachedMediaHandler));
    }
    attachedMediaElement = null;
    attachedMediaHandler = null;
  }

  /**
   * Attach listeners to an HTML5 media element
   */
  function attachMediaListeners(media) {
    if (media === attachedMediaElement) return;
    detachMediaListeners();
    if (!media) return;

    attachedMediaHandler = () => broadcastState();
    MEDIA_EVENTS.forEach((evt) => media.addEventListener(evt, attachedMediaHandler, { passive: true }));
    attachedMediaElement = media;
    broadcastState(true);
  }

  /**
   * Set an input element's value in a React-compatible way
   */
  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  /**
   * Playback Control Actions
   */
  const actions = {
    async playPause() {
      // 1. Try Main-World MediaSession bridge
      const handledByBridge = await dispatchToBridge('playPause');
      if (handledByBridge) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true, method: 'bridge-mediasession' };
      }

      // 2. Try UI Button in Plex DOM
      const media = findActiveMediaElement();
      const isCurrentlyPlaying = media ? !media.paused : false;

      const targetBtn = isCurrentlyPlaying
        ? findButton('pause') || findButton('playPause')
        : findButton('play') || findButton('playPause');
      if (targetBtn && simulateClick(targetBtn)) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true, method: 'ui-button' };
      }

      // 3. Direct HTML5 Media element fallback
      if (media) {
        try {
          if (media.paused) {
            await media.play();
          } else {
            media.pause();
          }
          setTimeout(() => broadcastState(true), 150);
          return { success: true, method: 'html5-media' };
        } catch (err) {
          console.warn('[Playkeys] HTML5 media play/pause error:', err);
        }
      }

      return { success: false, error: 'No player found' };
    },

    async play() {
      const handled = await dispatchToBridge('play');
      if (handled) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      const btn = findButton('play') || findButton('playPause');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      const media = findActiveMediaElement();
      if (media && media.paused) {
        media.play().catch(() => {});
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      return { success: false };
    },

    async pause() {
      const handled = await dispatchToBridge('pause');
      if (handled) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      const btn = findButton('pause') || findButton('playPause');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      const media = findActiveMediaElement();
      if (media && !media.paused) {
        media.pause();
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }
      return { success: false };
    },

    async next() {
      const handled = await dispatchToBridge('next');
      if (handled) {
        setTimeout(() => broadcastState(true), 250);
        return { success: true, method: 'bridge-next' };
      }

      const btn = findButton('next');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 250);
        return { success: true, method: 'ui-button' };
      }

      return { success: false, error: 'Next button unavailable' };
    },

    async previous() {
      const handled = await dispatchToBridge('previous');
      if (handled) {
        setTimeout(() => broadcastState(true), 250);
        return { success: true, method: 'bridge-prev' };
      }

      const btn = findButton('previous');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 250);
        return { success: true, method: 'ui-button' };
      }

      const media = findActiveMediaElement();
      if (media && media.currentTime > 3) {
        media.currentTime = 0;
        broadcastState(true);
        return { success: true, method: 'rewind' };
      }

      return { success: false, error: 'Previous button unavailable' };
    },

    async stop() {
      const handled = await dispatchToBridge('stop');
      if (handled) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }

      const btn = findButton('stop');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }

      const media = findActiveMediaElement();
      if (media) {
        media.pause();
        media.currentTime = 0;
        broadcastState(true);
        return { success: true };
      }
      return { success: false };
    },

    async volumeUp() {
      const media = findActiveMediaElement();
      if (media) {
        const nextVol = Math.min(1, Math.round((media.volume + 0.05) * 100) / 100);
        await actions.setVolume(nextVol);
        return { success: true, volume: nextVol };
      }
      return { success: false };
    },

    async volumeDown() {
      const media = findActiveMediaElement();
      if (media) {
        const nextVol = Math.max(0, Math.round((media.volume - 0.05) * 100) / 100);
        await actions.setVolume(nextVol);
        return { success: true, volume: nextVol };
      }
      return { success: false };
    },

    toggleMute() {
      const btn = findButton('mute');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }

      const media = findActiveMediaElement();
      if (media) {
        media.muted = !media.muted;
        broadcastState(true);
        return { success: true, muted: media.muted };
      }
      return { success: false };
    },

    async setVolume(value) {
      const target = Math.max(0, Math.min(1, parseFloat(value) || 0));

      // 1. Try Plex Web's custom VerticalSlider / VolumeSlider via main-bridge so React state persists
      const handledByBridge = await dispatchToBridge('setVolume', target);
      if (handledByBridge) {
        setTimeout(() => broadcastState(true), 80);
        return { success: true, volume: target, method: 'bridge-slider' };
      }

      // 2. Fallback: Direct HTML5 media element & range input
      const media = findActiveMediaElement();
      if (media) {
        media.volume = target;
        if (target > 0 && media.muted) media.muted = false;
      }

      const slider = document.querySelector(
        '[data-testid="volumeSlider"] input, input[type="range"][aria-label*="volume" i], [class*="VolumeSlider"] input'
      );
      if (slider) {
        const maxVal = parseFloat(slider.max);
        const scaled = maxVal > 0 && maxVal <= 1 ? target : Math.round(target * 100);
        setNativeInputValue(slider, String(scaled));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }

      broadcastState(true);
      return { success: true, volume: target };
    },

    async seek(seconds) {
      const target = Math.max(0, parseFloat(seconds) || 0);

      const handled = await dispatchToBridge('seek', target);
      if (handled) {
        setTimeout(() => broadcastState(true), 150);
        return { success: true };
      }

      const media = findActiveMediaElement();
      if (media && isFinite(media.duration)) {
        media.currentTime = Math.min(media.duration, target);
        broadcastState(true);
        return { success: true, currentTime: media.currentTime };
      }

      return { success: false };
    },

    toggleShuffle() {
      const btn = findButton('shuffle');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 200);
        return { success: true };
      }
      return { success: false };
    },

    toggleRepeat() {
      const btn = findButton('repeat');
      if (btn && simulateClick(btn)) {
        setTimeout(() => broadcastState(true), 200);
        return { success: true };
      }
      return { success: false };
    },

    async setRating(value) {
      const target = Math.max(0, Math.min(10, Math.round(Number(value) || 0)));
      const handled = await dispatchToBridge('setRating', target);
      if (handled) {
        setTimeout(() => broadcastState(true), 120);
        return { success: true, userRating: target };
      }
      return { success: false, error: 'Rating widget unavailable' };
    },

    async getQueue() {
      const res = await dispatchToBridgeWithResult('getQueue', null, 800);
      if (res.handled && res.result) {
        bridgeQueue = res.result;
      }
      return { success: Boolean(bridgeQueue), queue: bridgeQueue };
    },

    async refreshQueue(allowDomPeek = false) {
      const res = await dispatchToBridgeWithResult('refreshQueue', Boolean(allowDomPeek), 1500);
      if (res.result) {
        bridgeQueue = res.result;
      }
      return { success: Boolean(bridgeQueue), queue: bridgeQueue };
    },

    async playQueueItem(itemPayload) {
      const res = await dispatchToBridgeWithResult('playQueueItem', itemPayload, 1800);
      if (res.handled) {
        setTimeout(() => broadcastState(true), 250);
        return { success: true, queue: res.result || bridgeQueue };
      }
      return { success: false, error: 'Could not select queue item' };
    },

    getState() {
      return getPlayerState();
    }
  };

  /**
   * Listen for messages from background service worker or popup
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) return;

    if (request.action === 'getState') {
      sendResponse(actions.getState());
      return;
    }

    if (typeof actions[request.action] === 'function') {
      Promise.resolve(actions[request.action](request.value))
        .then((res) => sendResponse(res || { success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    sendResponse({ success: false, error: `Unknown action: ${request.action}` });
  });

  /**
   * Observe DOM mutations (debounced) for dynamically mounted media or control bars
   */
  function setupDOMObserver() {
    const targetNode = document.body || document.documentElement;
    if (!targetNode) return;

    domObserver = new MutationObserver(() => {
      if (mutationDebounceTimer) return;
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        if (!isExtensionContextValid()) {
          teardown();
          return;
        }
        const media = findActiveMediaElement();
        if (media !== attachedMediaElement) {
          attachMediaListeners(media);
        }
        broadcastState();
      }, 150);
    });

    domObserver.observe(targetNode, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'aria-checked', 'src', 'data-testid']
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!isExtensionContextValid()) {
        teardown();
        return;
      }
      const media = findActiveMediaElement();
      if (media && !media.paused) {
        broadcastState();
      }
    }, 1000);
  }

  // Page unload / navigation listener to clear badges without disabling BFCache
  window.addEventListener('pagehide', () => {
    if (!isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'PLEX_TAB_CLOSING' }).catch(() => {});
    } catch {
      // Ignore
    }
  });

  // Initialization
  const initMedia = findActiveMediaElement();
  if (initMedia) {
    attachMediaListeners(initMedia);
  }
  setupDOMObserver();
  broadcastState(true);

  console.log('[Playkeys] Enhanced content script active on', window.location.href);
})();
