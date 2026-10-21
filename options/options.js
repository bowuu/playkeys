/**
 * Playkeys - Options Controller
 * Handles dynamic origin permission requests via chrome.permissions.request,
 * custom server storage, tab navigation, and shortcut settings.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Navigation references
  const navItems = document.querySelectorAll('.nav-item');
  const sections = {
    servers: document.getElementById('section-servers'),
    shortcuts: document.getElementById('section-shortcuts'),
    about: document.getElementById('section-about')
  };

  // Server management references
  const addServerForm = document.getElementById('addServerForm');
  const serverUrlInput = document.getElementById('serverUrlInput');
  const originNotice = document.getElementById('originNotice');
  const customServerList = document.getElementById('customServerList');
  const serverCountBadge = document.getElementById('serverCountBadge');
  const btnOpenChromeShortcuts = document.getElementById('btnOpenChromeShortcuts');

  /**
   * Tab Navigation handler
   */
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.getAttribute('data-tab');

      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');

      Object.keys(sections).forEach(key => {
        if (key === targetTab) {
          sections[key].classList.remove('hidden');
        } else {
          sections[key].classList.add('hidden');
        }
      });
    });
  });

  /**
   * Convert user input into a valid Chrome extension match pattern
   * Chrome MV3 match patterns: <scheme>://<host>/<path>
   * Note: Chrome match patterns do not allow port numbers in the host segment.
   */
  function normalizeToMatchPattern(rawInput) {
    let urlString = rawInput.trim();
    if (!/^https?:\/\//i.test(urlString)) {
      urlString = 'http://' + urlString;
    }

    try {
      const parsed = new URL(urlString);
      const scheme = parsed.protocol.replace(':', '');
      if (scheme !== 'http' && scheme !== 'https') {
        throw new Error('Only http and https protocols are supported.');
      }

      // Chrome match pattern: scheme://hostname/*
      const pattern = `${scheme}://${parsed.hostname}/*`;
      const displayName = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      
      return {
        pattern,
        displayName,
        displayUrl: parsed.origin + (parsed.pathname !== '/' ? parsed.pathname : '')
      };
    } catch (err) {
      throw new Error(`Invalid URL format: ${err.message}`);
    }
  }

  /**
   * Show feedback message
   */
  function showNotice(message, isError = false) {
    originNotice.textContent = message;
    originNotice.className = `feedback-msg ${isError ? 'error' : 'success'}`;
    originNotice.classList.remove('hidden');

    setTimeout(() => {
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
        // Verify current permission state
        const hasPermission = await chrome.permissions.contains({
          origins: [server.pattern]
        });

        const itemEl = document.createElement('div');
        itemEl.className = 'server-item';
        itemEl.innerHTML = `
          <div class="server-info">
            <div class="server-name">${escapeHtml(server.name || server.displayName)}</div>
            <div class="server-pattern">${escapeHtml(server.pattern)} &bull; <span style="opacity:0.8">${escapeHtml(server.displayUrl)}</span></div>
          </div>
          <div class="server-badges">
            <span class="status-tag ${hasPermission ? 'granted-tag' : 'default-tag'}">
              ${hasPermission ? 'Authorized' : 'Permission Revoked'}
            </span>
            <button class="btn-remove" data-id="${server.id}" title="Remove server and revoke permission" aria-label="Remove server">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          </div>
        `;

        // Remove listener
        itemEl.querySelector('.btn-remove').addEventListener('click', () => {
          removeServer(server);
        });

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
      normalized = normalizeToMatchPattern(rawUrl);
    } catch (err) {
      showNotice(err.message, true);
      return;
    }

    try {
      // Prompt user for dynamic origin permission
      const granted = await chrome.permissions.request({
        origins: [normalized.pattern]
      });

      if (!granted) {
        showNotice('Permission request was denied or cancelled.', true);
        return;
      }

      // Read existing servers
      const data = await chrome.storage.sync.get({ customServers: [], customOrigins: [] });
      const servers = data.customServers || [];
      const origins = data.customOrigins || [];

      // Check if already added
      const exists = servers.some(s => s.pattern === normalized.pattern);
      if (exists) {
        showNotice(`Server origin ${normalized.pattern} is already registered.`);
        return;
      }

      const newServer = {
        id: 'srv_' + Date.now(),
        pattern: normalized.pattern,
        displayName: normalized.displayName,
        displayUrl: normalized.displayUrl,
        name: `Plex Server (${normalized.displayName})`,
        addedAt: Date.now()
      };

      servers.push(newServer);
      if (!origins.includes(normalized.pattern)) {
        origins.push(normalized.pattern);
      }

      await chrome.storage.sync.set({ customServers: servers, customOrigins: origins });

      // Notify background service worker to update dynamic content script registrations
      await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_ORIGINS' });

      serverUrlInput.value = '';
      showNotice(`Successfully authorized and added ${normalized.pattern}`);
      loadServers();
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
      // Revoke permission dynamically
      try {
        await chrome.permissions.remove({
          origins: [server.pattern]
        });
      } catch (permErr) {
        console.warn('[Playkeys Options] Permission revoke notice:', permErr);
      }

      // Update storage
      const data = await chrome.storage.sync.get({ customServers: [], customOrigins: [] });
      const filteredServers = (data.customServers || []).filter(s => s.id !== server.id);
      const filteredOrigins = (data.customOrigins || []).filter(orig => orig !== server.pattern);

      await chrome.storage.sync.set({
        customServers: filteredServers,
        customOrigins: filteredOrigins
      });

      // Notify background
      await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_ORIGINS' });

      showNotice(`Removed ${server.displayName} and revoked origin access.`);
      loadServers();
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

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initial load
  loadServers();
});
