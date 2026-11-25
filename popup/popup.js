/**
 * Playkeys - Popup Controller
 * Manages UI updates, user interactions, timeline scrubbing,
 * quick server authorization, and player control dispatching.
 */

import { normalizeServerInput, saveCustomServer } from '../shared/servers.js';

document.addEventListener('DOMContentLoaded', () => {
  // DOM References
  const playerCard = document.getElementById('playerCard');
  const emptyState = document.getElementById('emptyState');
  const connectionBadge = document.getElementById('connectionBadge');
  const focusTabBtn = document.getElementById('focusTabBtn');
  const optionsBtn = document.getElementById('optionsBtn');

  // Detected Unconfigured Server Banner
  const unconfiguredBanner = document.getElementById('unconfiguredBanner');
  const detectedServerUrl = document.getElementById('detectedServerUrl');
  const btnGrantDetected = document.getElementById('btnGrantDetected');

  // Track Metadata
  const trackArtwork = document.getElementById('trackArtwork');
  const artworkPlaceholder = document.getElementById('artworkPlaceholder');
  const trackTitle = document.getElementById('trackTitle');
  const trackArtist = document.getElementById('trackArtist');
  const trackAlbum = document.getElementById('trackAlbum');

  // Timeline
  const currentTimeEl = document.getElementById('currentTime');
  const totalDurationEl = document.getElementById('totalDuration');
  const seekBar = document.getElementById('seekBar');

  // Controls
  const btnShuffle = document.getElementById('btnShuffle');
  const btnPrev = document.getElementById('btnPrev');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const iconPlay = document.getElementById('iconPlay');
  const iconPause = document.getElementById('iconPause');
  const btnNext = document.getElementById('btnNext');
  const btnRepeat = document.getElementById('btnRepeat');
  const repeatBadge = document.getElementById('repeatBadge');

  // Volume
  const btnMute = document.getElementById('btnMute');
  const iconVolHigh = document.getElementById('iconVolHigh');
  const iconVolMuted = document.getElementById('iconVolMuted');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumePercent = document.getElementById('volumePercent');

  // Empty State Actions
  const openPlexWebBtn = document.getElementById('openPlexWebBtn');
  const openOptionsBtn = document.getElementById('openOptionsBtn');

  // State Tracking
  let activeTab = null;
  let currentState = null;
  let detectedTab = null;
  let isUserScrubbing = false;
  let isUserAdjustingVolume = false;
  let lastVolumeSendAt = 0;
  let pendingVolumeTimer = null;
  let lastArtworkUrl = '';

  /**
   * Format seconds to m:ss or h:mm:ss
   */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;

    const pad = (n) => n.toString().padStart(2, '0');
    if (hrs > 0) {
      return `${hrs}:${pad(mins)}:${pad(secs)}`;
    }
    return `${mins}:${pad(secs)}`;
  }

  /**
   * Update visual slider background gradient
   */
  function updateSliderFill(slider, percent, fillColor = '#e5a00d', emptyColor = '#262830') {
    const p = Math.max(0, Math.min(100, percent));
    slider.style.background = `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${p}%, ${emptyColor} ${p}%, ${emptyColor} 100%)`;
  }

  /**
   * Update artwork only when URL changes to avoid flicker/repeated loads
   */
  function updateArtwork(artworkUrl) {
    const nextUrl = artworkUrl || '';
    if (!nextUrl) {
      lastArtworkUrl = '';
      trackArtwork.removeAttribute('src');
      showArtworkPlaceholder();
      return;
    }

    if (nextUrl === lastArtworkUrl) return;
    lastArtworkUrl = nextUrl;

    trackArtwork.onload = () => {
      trackArtwork.classList.remove('hidden');
      artworkPlaceholder.classList.add('hidden');
    };
    trackArtwork.onerror = () => {
      showArtworkPlaceholder();
    };
    trackArtwork.src = nextUrl;
  }

  /**
   * Render state into UI
   */
  function renderState(tab, state, unconfigured) {
    activeTab = tab;
    currentState = state;
    detectedTab = unconfigured;

    // Handle Unconfigured Local Server Banner
    if (unconfigured && !tab) {
      unconfiguredBanner.classList.remove('hidden');
      try {
        const u = new URL(unconfigured.url);
        detectedServerUrl.textContent = u.origin;
      } catch {
        detectedServerUrl.textContent = unconfigured.url;
      }
    } else {
      unconfiguredBanner.classList.add('hidden');
    }

    if (!tab) {
      playerCard.classList.add('hidden');
      emptyState.classList.remove('hidden');
      focusTabBtn.classList.add('hidden');

      connectionBadge.className = 'connection-badge disconnected';
      connectionBadge.querySelector('.status-label').textContent = 'Offline';
      return;
    }

    playerCard.classList.remove('hidden');
    emptyState.classList.add('hidden');
    focusTabBtn.classList.remove('hidden');

    let hostDisplay = 'Plex Web';
    try {
      const url = new URL(tab.url);
      hostDisplay = url.port ? `${url.hostname}:${url.port}` : url.hostname.replace('www.', '');
    } catch {
      // fallback
    }

    connectionBadge.className = 'connection-badge connected';
    connectionBadge.querySelector('.status-label').textContent = hostDisplay;

    if (!state) {
      trackTitle.textContent = 'Plex Connected';
      trackArtist.textContent = 'Waiting for media to play...';
      trackAlbum.textContent = '';
      updateArtwork('');
      return;
    }

    trackTitle.textContent = state.title || (state.hasMedia ? 'Plex Playback' : 'Idle');
    trackArtist.textContent = state.artist || (state.isPlaying ? 'Now Playing' : 'Plex Player');
    trackAlbum.textContent = state.album || '';

    updateArtwork(state.artworkUrl);

    if (state.isPlaying) {
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
      btnPlayPause.title = 'Pause (MediaPlayPause)';
    } else {
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
      btnPlayPause.title = 'Play (MediaPlayPause)';
    }

    const curTime = state.currentTime || 0;
    const dur = state.duration || 0;

    if (!isUserScrubbing) {
      currentTimeEl.textContent = formatTime(curTime);
      totalDurationEl.textContent = formatTime(dur);

      if (dur > 0) {
        const percent = (curTime / dur) * 100;
        seekBar.value = percent;
        updateSliderFill(seekBar, percent);
      } else {
        seekBar.value = 0;
        updateSliderFill(seekBar, 0);
      }
    }

    if (state.isShuffle) {
      btnShuffle.classList.add('active');
    } else {
      btnShuffle.classList.remove('active');
    }

    if (state.repeatMode === 'one') {
      btnRepeat.classList.add('active');
      repeatBadge.classList.remove('hidden');
      repeatBadge.textContent = '1';
    } else if (state.repeatMode === 'all') {
      btnRepeat.classList.add('active');
      repeatBadge.classList.add('hidden');
    } else {
      btnRepeat.classList.remove('active');
      repeatBadge.classList.add('hidden');
    }

    if (!isUserAdjustingVolume) {
      const volPercent = Math.round((state.volume ?? 1) * 100);
      const isMuted = !!state.isMuted || volPercent === 0;

      if (isMuted) {
        iconVolHigh.classList.add('hidden');
        iconVolMuted.classList.remove('hidden');
        volumeSlider.value = 0;
        volumePercent.textContent = '0%';
        updateSliderFill(volumeSlider, 0);
      } else {
        iconVolHigh.classList.remove('hidden');
        iconVolMuted.classList.add('hidden');
        volumeSlider.value = volPercent;
        volumePercent.textContent = `${volPercent}%`;
        updateSliderFill(volumeSlider, volPercent);
      }
    }
  }

  function showArtworkPlaceholder() {
    trackArtwork.classList.add('hidden');
    artworkPlaceholder.classList.remove('hidden');
  }

  /**
   * Dispatch action to background worker
   */
  async function sendPlayerAction(action, value = null) {
    try {
      return await chrome.runtime.sendMessage({
        type: 'EXECUTE_PLAYER_ACTION',
        action,
        value
      });
    } catch (err) {
      console.warn('[Playkeys Popup] Action send error:', err);
      return null;
    }
  }

  /**
   * Fetch active tab and state
   */
  async function refreshActiveTab() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PLEX_TAB' });
      if (response) {
        renderState(response.tab, response.state, response.unconfiguredTab);
      } else {
        renderState(null, null, null);
      }
    } catch {
      renderState(null, null, null);
    }
  }

  // Handle Timeline Scrubbing
  seekBar.addEventListener('pointerdown', () => {
    isUserScrubbing = true;
  });

  seekBar.addEventListener('input', () => {
    isUserScrubbing = true;
    const percent = parseFloat(seekBar.value);
    updateSliderFill(seekBar, percent);

    if (currentState && currentState.duration > 0) {
      const scrubSeconds = (percent / 100) * currentState.duration;
      currentTimeEl.textContent = formatTime(scrubSeconds);
    }
  });

  const endScrubbing = async () => {
    if (isUserScrubbing) {
      isUserScrubbing = false;
      if (currentState && currentState.duration > 0) {
        const percent = parseFloat(seekBar.value);
        const targetSeconds = (percent / 100) * currentState.duration;
        await sendPlayerAction('seek', targetSeconds);
      }
    }
  };

  window.addEventListener('pointerup', endScrubbing);
  window.addEventListener('mouseup', endScrubbing);
  window.addEventListener('touchend', endScrubbing);

  // Handle Controls Click Events
  async function dispatchAndRefresh(action, delayMs = 180) {
    await sendPlayerAction(action);
    setTimeout(refreshActiveTab, delayMs);
  }

  btnPlayPause.addEventListener('click', async () => {
    if (currentState) {
      currentState.isPlaying = !currentState.isPlaying;
      currentState.isPaused = !currentState.isPlaying;
      renderState(activeTab, currentState, detectedTab);
    }
    await dispatchAndRefresh('playPause', 160);
  });

  btnNext.addEventListener('click', () => dispatchAndRefresh('next', 250));
  btnPrev.addEventListener('click', () => dispatchAndRefresh('previous', 250));
  btnShuffle.addEventListener('click', () => dispatchAndRefresh('toggleShuffle', 200));
  btnRepeat.addEventListener('click', () => dispatchAndRefresh('toggleRepeat', 200));
  btnMute.addEventListener('click', () => dispatchAndRefresh('toggleMute', 150));

  // Throttled Volume Slider with drag guard
  function scheduleVolumeSend(val) {
    const now = Date.now();
    const elapsed = now - lastVolumeSendAt;
    if (elapsed >= 50) {
      lastVolumeSendAt = now;
      sendPlayerAction('setVolume', val / 100);
    } else {
      clearTimeout(pendingVolumeTimer);
      pendingVolumeTimer = setTimeout(() => {
        lastVolumeSendAt = Date.now();
        sendPlayerAction('setVolume', val / 100);
      }, 50 - elapsed);
    }
  }

  volumeSlider.addEventListener('pointerdown', () => {
    isUserAdjustingVolume = true;
  });

  volumeSlider.addEventListener('input', () => {
    isUserAdjustingVolume = true;
    const val = parseInt(volumeSlider.value, 10);
    volumePercent.textContent = `${val}%`;
    updateSliderFill(volumeSlider, val);
    if (val === 0) {
      iconVolHigh.classList.add('hidden');
      iconVolMuted.classList.remove('hidden');
    } else {
      iconVolHigh.classList.remove('hidden');
      iconVolMuted.classList.add('hidden');
    }
    scheduleVolumeSend(val);
  });

  const endVolumeAdjust = () => {
    if (isUserAdjustingVolume) {
      isUserAdjustingVolume = false;
      clearTimeout(pendingVolumeTimer);
      const val = parseInt(volumeSlider.value, 10);
      sendPlayerAction('setVolume', val / 100);
    }
  };

  window.addEventListener('pointerup', endVolumeAdjust);
  window.addEventListener('mouseup', endVolumeAdjust);
  window.addEventListener('touchend', endVolumeAdjust);

  // Quick One-Click Connect for Detected Local Server
  btnGrantDetected.addEventListener('click', async () => {
    if (!detectedTab || !detectedTab.url) return;

    try {
      const normalized = normalizeServerInput(detectedTab.url);
      const granted = await chrome.permissions.request({
        origins: [normalized.pattern]
      });

      if (granted) {
        await saveCustomServer(normalized);
        await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_ORIGINS' });
        unconfiguredBanner.classList.add('hidden');
        await refreshActiveTab();
      }
    } catch (err) {
      console.warn('[Playkeys Popup] Quick grant error:', err);
    }
  });

  // Top Bar Actions
  focusTabBtn.addEventListener('click', () => {
    if (activeTab && activeTab.id) {
      chrome.runtime.sendMessage({ type: 'FOCUS_PLEX_TAB', tabId: activeTab.id });
    }
  });

  optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  openPlexWebBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://app.plex.tv/desktop' });
    window.close();
  });

  // Real-time state listener from content scripts
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'PLEX_STATE_UPDATE') return;

    if (sender.tab && activeTab && sender.tab.id === activeTab.id && message.state) {
      renderState(activeTab, message.state, detectedTab);
    } else {
      refreshActiveTab();
    }
  });

  // Polling to keep time smooth while popup is visible
  setInterval(refreshActiveTab, 1000);

  // Initial fetch
  refreshActiveTab();
});
