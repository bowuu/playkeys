/**
 * Playkeys - Options Controller
 * Handles dynamic origin permission requests via chrome.permissions.request,
 * custom server storage, tab navigation, and shortcut settings.
 */

import { normalizeServerInput, saveCustomServer } from '../shared/servers.js';

document.addEventListener('DOMContentLoaded', () => {
  // Navigation references
  const navItems = document.querySelectorAll('.nav-item');
  const sections = {
    servers: document.getElementById('section-servers'),
    preferences: document.getElementById('section-preferences'),
    shortcuts: document.getElementById('section-shortcuts'),
    about: document.getElementById('section-about')
  };

  // Preferences references
  const ratingModeGrid = document.getElementById('ratingModeGrid');
  const ratingModeRadios = document.querySelectorAll('input[name="ratingMode"]');
  const prefsNotice = document.getElementById('prefsNotice');

  // Server management references
  const addServerForm = document.getElementById('addServerForm');
  const serverUrlInput = document.getElementById('serverUrlInput');
  const originNotice = document.getElementById('originNotice');
  const customServerList = document.getElementById('customServerList');
  const serverCountBadge = document.getElementById('serverCountBadge');
  const btnOpenChromeShortcuts = document.getElementById('btnOpenChromeShortcuts');

  /**
   * Tab Navigation handler (supports URL hash & aria-current)
   */
  function activateTab(tabName) {
    const targetTab = Object.prototype.hasOwnProperty.call(sections, tabName) ? tabName : 'servers';

    navItems.forEach((nav) => {
      const isMatch = nav.getAttribute('data-tab') === targetTab;
      nav.classList.toggle('active', isMatch);
      if (isMatch) {
        nav.setAttribute('aria-current', 'page');
      } else {
        nav.removeAttribute('aria-current');
      }
    });

    Object.keys(sections).forEach((key) => {
      sections[key].classList.toggle('hidden', key !== targetTab);
    });
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.getAttribute('data-tab');
      activateTab(targetTab);
      if (history.replaceState) {
        history.replaceState(null, '', `#${targetTab}`);
      }
    });
  });

  window.addEventListener('hashchange', () => {
    const hashTab = window.location.hash.replace(/^#/, '');
    if (hashTab) activateTab(hashTab);
  });

  const initialTab = window.location.hash.replace(/^#/, '');
  if (initialTab) {
    activateTab(initialTab);
  }

  /**
   * Show feedback message
   */
  let noticeTimer = null;
  function showNotice(message, isError = false) {
    originNotice.textContent = message;
    originNotice.className = `feedback-msg ${isError ? 'error' : 'success'}`;
    originNotice.classList.remove('hidden');

    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      originNotice.classList.add('hidden');
    }, 5000);
  }

  /**
   * Load and render configured servers
   */
  async function loadServers() {
    try {
      const data = await chrome.storage.sync.get({ customServers: [] });
      const servers = data.customServers || [];

      customServerList.innerHTML = '';
      serverCountBadge.textContent = `${servers.length + 1} Server${servers.length === 0 ? '' : 's'}`;

      if (servers.length === 0) {
        return;
      }

      for (const server of servers) {
        const hasPermission = await chrome.permissions.contains({
          origins: [server.pattern]
        });

        const itemEl = document.createElement('div');
        itemEl.className = 'server-item';

        const infoEl = document.createElement('div');
        infoEl.className = 'server-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'server-name';
        nameEl.textContent = server.name || server.displayName || '';

        const patternEl = document.createElement('div');
        patternEl.className = 'server-pattern';
        patternEl.appendChild(document.createTextNode(`${server.pattern} \u2022 `));
        const urlSpan = document.createElement('span');
        urlSpan.style.opacity = '0.8';
        urlSpan.textContent = server.displayUrl || '';
        patternEl.appendChild(urlSpan);

        infoEl.appendChild(nameEl);
        infoEl.appendChild(patternEl);

        const badgesEl = document.createElement('div');
        badgesEl.className = 'server-badges';

        const statusEl = document.createElement('span');
        statusEl.className = `status-tag ${hasPermission ? 'granted-tag' : 'default-tag'}`;
        statusEl.textContent = hasPermission ? 'Authorized' : 'Permission Revoked';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-remove';
        removeBtn.dataset.id = server.id || '';
        removeBtn.title = 'Remove server and revoke permission';
        removeBtn.setAttribute('aria-label', `Remove ${server.displayName || 'server'}`);

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('fill', 'currentColor');
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z');
        svg.appendChild(path);
        removeBtn.appendChild(svg);

        removeBtn.addEventListener('click', () => {
          removeServer(server);
        });

        badgesEl.appendChild(statusEl);
        badgesEl.appendChild(removeBtn);

        itemEl.appendChild(infoEl);
        itemEl.appendChild(badgesEl);
        customServerList.appendChild(itemEl);
      }
    } catch (err) {
      console.error('[Playkeys Options] Error loading servers:', err);
    }
  }

  /**
   * Add Server: Request dynamic origin permission (Principle of Least Privilege)
   */
  addServerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawUrl = serverUrlInput.value;

    let normalized;
    try {
      normalized = normalizeServerInput(rawUrl);
    } catch (err) {
      showNotice(err.message, true);
      return;
    }

    try {
      const granted = await chrome.permissions.request({
        origins: [normalized.pattern]
      });

      if (!granted) {
        showNotice('Permission request was denied or cancelled.', true);
        return;
      }

      const result = await saveCustomServer(normalized);

      // Always re-sync dynamic content scripts (covers re-granting revoked permissions too)
      await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_ORIGINS' });

      serverUrlInput.value = '';
      if (result.updated) {
        showNotice(`Refreshed authorization for ${normalized.pattern}`);
      } else {
        showNotice(`Successfully authorized and added ${normalized.pattern}`);
      }
      await loadServers();
    } catch (err) {
      console.error('[Playkeys Options] Add server failed:', err);
      showNotice(`Error adding server: ${err.message}`, true);
    }
  });

  /**
   * Remove Server & Revoke Dynamic Permissions
   */
  async function removeServer(server) {
    const confirmed = confirm(`Are you sure you want to remove "${server.name}" and revoke its origin permissions?`);
    if (!confirmed) return;

    try {
      try {
        await chrome.permissions.remove({
          origins: [server.pattern]
        });
      } catch (permErr) {
        console.warn('[Playkeys Options] Permission revoke notice:', permErr);
      }

      const data = await chrome.storage.sync.get({ customServers: [], customOrigins: [] });
      const filteredServers = (data.customServers || []).filter((s) => s.id !== server.id);
      const filteredOrigins = (data.customOrigins || []).filter((orig) => orig !== server.pattern);

      await chrome.storage.sync.set({
        customServers: filteredServers,
        customOrigins: filteredOrigins
      });

      await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_ORIGINS' });

      showNotice(`Removed ${server.displayName} and revoked origin access.`);
      await loadServers();
    } catch (err) {
      console.error('[Playkeys Options] Remove error:', err);
      showNotice(`Error removing server: ${err.message}`, true);
    }
  }

  /**
   * Open Chrome Shortcuts management page
   */
  btnOpenChromeShortcuts.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  /**
   * Populate shortcuts table with live keybindings from chrome.commands
   */
  async function loadShortcuts() {
    if (!chrome.commands?.getAll) return;
    try {
      const commands = await chrome.commands.getAll();
      for (const cmd of commands) {
        const row = document.querySelector(`tr[data-command="${CSS.escape(cmd.name)}"]`);
        if (!row) continue;
        const cell = row.querySelector('.shortcut-cell');
        if (!cell) continue;
        cell.replaceChildren();
        if (cmd.shortcut) {
          const kbd = document.createElement('kbd');
          kbd.textContent = cmd.shortcut;
          cell.appendChild(kbd);
        } else {
          const unassigned = document.createElement('span');
          unassigned.className = 'unassigned-key';
          unassigned.textContent = 'Unassigned';
          cell.appendChild(unassigned);
        }
      }
    } catch (err) {
      console.warn('[Playkeys Options] Shortcuts load error:', err);
    }
  }

  // Initial load
  loadServers();
  loadPreferences();
  loadShortcuts();

  /**
   * Load and bind Popup & Rating Preferences
   */
  let prefsNoticeTimer = null;
  function showPrefsNotice(message) {
    prefsNotice.textContent = message;
    prefsNotice.className = 'feedback-msg success';
    prefsNotice.classList.remove('hidden');
    clearTimeout(prefsNoticeTimer);
    prefsNoticeTimer = setTimeout(() => {
      prefsNotice.classList.add('hidden');
    }, 3000);
  }

  function highlightSelectedModeCard(mode) {
    if (!ratingModeGrid) return;
    ratingModeGrid.querySelectorAll('.mode-card').forEach((card) => {
      const isMatch = card.getAttribute('data-mode') === mode;
      card.classList.toggle('selected', isMatch);
    });
  }

  async function loadPreferences() {
    try {
      const data = await chrome.storage.sync.get({ ratingMode: 'half_stars' });
      const mode = data.ratingMode || 'half_stars';
      ratingModeRadios.forEach((radio) => {
        radio.checked = radio.value === mode;
      });
      highlightSelectedModeCard(mode);
    } catch (err) {
      console.warn('[Playkeys Options] Preferences load error:', err);
    }
  }

  ratingModeRadios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const mode = radio.value;
      highlightSelectedModeCard(mode);
      try {
        await chrome.storage.sync.set({ ratingMode: mode });
        showPrefsNotice('Rating preference saved.');
      } catch (err) {
        console.warn('[Playkeys Options] Preferences save error:', err);
      }
    });
  });
});
