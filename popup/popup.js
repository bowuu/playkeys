/**
 * Playkeys - Popup Controller
 * Manages UI updates, user interactions, timeline scrubbing,
 * track ratings (5-star half/whole & thumbs), quick server authorization,
 * and player control dispatching.
 */

import { normalizeServerInput, saveCustomServer } from '../shared/servers.js';

const STAR_FULL_PATH =
  'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
const STAR_HALF_PATH =
  'M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z';

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

  // Rating Controls
  const ratingSection = document.getElementById('ratingSection');
  const starRatingRow = document.getElementById('starRatingRow');
  const thumbsRatingRow = document.getElementById('thumbsRatingRow');
  const btnThumbDown = document.getElementById('btnThumbDown');
  const btnThumbUp = document.getElementById('btnThumbUp');
  const ratingValueLabel = document.getElementById('ratingValueLabel');

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
  let volumeLockUntil = 0;
  let lastVolumeSendAt = 0;
  let pendingVolumeTimer = null;
  let lastArtworkUrl = '';
  let ratingMode = 'half_stars';
  let hoverRating = null;

  /**
   * Build the 5 star slots inside starRatingRow once
   */
  function initStarSlots() {
    const svgNS = 'http://www.w3.org/2000/svg';
    starRatingRow.innerHTML = '';
    for (let i = 0; i < 5; i += 1) {
      const slot = document.createElement('span');
      slot.className = 'star-slot';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');

      const bgPath = document.createElementNS(svgNS, 'path');
      bgPath.setAttribute('class', 'star-bg');
      bgPath.setAttribute('d', STAR_FULL_PATH);

      const fgPath = document.createElementNS(svgNS, 'path');
      fgPath.setAttribute('class', 'star-fg');
      fgPath.setAttribute('d', '');

      svg.appendChild(bgPath);
      svg.appendChild(fgPath);
      slot.appendChild(svg);
      starRatingRow.appendChild(slot);
    }
  }

  /**
   * Paint star SVGs and label for a 0..10 rating value
   */
  function paintStars(value) {
    const val = Math.max(0, Math.min(10, Math.round(value || 0)));
    const slots = starRatingRow.querySelectorAll('.star-slot');
    slots.forEach((slot, idx) => {
      const fg = slot.querySelector('.star-fg');
      const fullThreshold = (idx + 1) * 2;
      const halfThreshold = fullThreshold - 1;
      if (val >= fullThreshold) {
        fg.setAttribute('d', STAR_FULL_PATH);
      } else if (val === halfThreshold) {
        fg.setAttribute('d', STAR_HALF_PATH);
      } else {
        fg.setAttribute('d', '');
      }
    });
    starRatingRow.setAttribute('aria-valuenow', String(val));
  }

  /**
   * Format rating label text for display
   */
  function formatRatingLabel(val) {
    if (!val || val <= 0) return 'Unrated';
    if (ratingMode === 'thumbs') {
      if (val >= 7) return 'Liked';
      if (val <= 4) return 'Disliked';
      return `${(val / 2).toFixed(val % 2 ? 1 : 0)} / 5`;
    }
    const stars = val / 2;
    return `${Number.isInteger(stars) ? stars : stars.toFixed(1)} / 5`;
  }

  /**
   * Render rating section visibility and controls
   */
  function renderRating(state) {
    if (ratingMode === 'off' || !state || !state.canRate) {
      ratingSection.classList.add('hidden');
      return;
    }

    ratingSection.classList.remove('hidden');
    const actualVal = Number.isFinite(state.userRating) ? state.userRating : 0;
    const displayVal = hoverRating !== null ? hoverRating : actualVal;

    if (ratingMode === 'thumbs') {
      starRatingRow.classList.add('hidden');
      thumbsRatingRow.classList.remove('hidden');
      btnThumbUp.classList.toggle('active', actualVal >= 7);
      btnThumbDown.classList.toggle('active', actualVal >= 1 && actualVal <= 4);
      ratingValueLabel.textContent = formatRatingLabel(actualVal);
    } else {
      thumbsRatingRow.classList.add('hidden');
      starRatingRow.classList.remove('hidden');
      paintStars(displayVal);
      ratingValueLabel.textContent = formatRatingLabel(displayVal);
    }
  }

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
      renderRating(null);
      return;
    }

    trackTitle.textContent = state.title || (state.hasMedia ? 'Plex Playback' : 'Idle');
    trackArtist.textContent = state.artist || (state.isPlaying ? 'Now Playing' : 'Plex Player');
    trackAlbum.textContent = state.album || '';

    updateArtwork(state.artworkUrl);
    renderRating(state);

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

    btnShuffle.classList.toggle('active', Boolean(state.isShuffle));

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

    if (!isUserAdjustingVolume && Date.now() >= volumeLockUntil) {
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

  /**
   * Compute star rating (1..10) from pointer X coordinate over starRatingRow
   */
  function getStarValueFromPointer(event) {
    const rect = starRatingRow.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    if (ratingMode === 'whole_stars') {
      return Math.max(1, Math.min(5, Math.ceil(ratio * 5))) * 2;
    }
    return Math.max(1, Math.min(10, Math.ceil(ratio * 10)));
  }

  async function commitRating(nextRating) {
    if (currentState) {
      currentState.userRating = nextRating;
      renderRating(currentState);
    }
    await sendPlayerAction('setRating', nextRating);
    setTimeout(refreshActiveTab, 180);
  }

  starRatingRow.addEventListener('mousemove', (e) => {
    hoverRating = getStarValueFromPointer(e);
    renderRating(currentState);
  });

  starRatingRow.addEventListener('mouseleave', () => {
    hoverRating = null;
    renderRating(currentState);
  });

  starRatingRow.addEventListener('click', (e) => {
    const picked = getStarValueFromPointer(e);
    const current = currentState?.userRating || 0;
    const nextRating = picked === current ? 0 : picked;
    hoverRating = null;
    commitRating(nextRating);
  });

  starRatingRow.addEventListener('keydown', (e) => {
    if (!currentState?.canRate) return;
    const step = ratingMode === 'whole_stars' ? 2 : 1;
    const current = currentState.userRating || 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      commitRating(Math.min(10, current + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      commitRating(Math.max(0, current - step));
    }
  });

  btnThumbUp.addEventListener('click', () => {
    const current = currentState?.userRating || 0;
    commitRating(current >= 7 ? 0 : 10);
  });

  btnThumbDown.addEventListener('click', () => {
    const current = currentState?.userRating || 0;
    commitRating(current >= 1 && current <= 4 ? 0 : 2);
  });

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

  // Throttled Volume Slider with drag guard & post-release lock
  function scheduleVolumeSend(val) {
    const now = Date.now();
    volumeLockUntil = now + 450;
    const elapsed = now - lastVolumeSendAt;
    if (elapsed >= 80) {
      lastVolumeSendAt = now;
      sendPlayerAction('setVolume', val / 100);
    } else {
      clearTimeout(pendingVolumeTimer);
      pendingVolumeTimer = setTimeout(() => {
        lastVolumeSendAt = Date.now();
        volumeLockUntil = lastVolumeSendAt + 450;
        sendPlayerAction('setVolume', val / 100);
      }, 80 - elapsed);
    }
  }

  volumeSlider.addEventListener('pointerdown', () => {
    isUserAdjustingVolume = true;
    volumeLockUntil = Date.now() + 450;
  });

  volumeSlider.addEventListener('input', () => {
    isUserAdjustingVolume = true;
    volumeLockUntil = Date.now() + 450;
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

  const endVolumeAdjust = async () => {
    if (isUserAdjustingVolume) {
      isUserAdjustingVolume = false;
      volumeLockUntil = Date.now() + 450;
      clearTimeout(pendingVolumeTimer);
      const val = parseInt(volumeSlider.value, 10);
      await sendPlayerAction('setVolume', val / 100);
      setTimeout(refreshActiveTab, 120);
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

  // Sync rating preference changes immediately
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.ratingMode) {
      ratingMode = changes.ratingMode.newValue || 'half_stars';
      renderRating(currentState);
    }
  });

  // Initialization
  initStarSlots();
  chrome.storage.sync
    .get({ ratingMode: 'half_stars' })
    .then((data) => {
      ratingMode = data.ratingMode || 'half_stars';
      renderRating(currentState);
    })
    .catch(() => {});

  setInterval(refreshActiveTab, 1000);
  refreshActiveTab();
});
