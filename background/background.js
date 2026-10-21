/**
 * Playkeys - Background Service Worker (Manifest V3)
 * Handles tab discovery, auto-injection on startup, command routing,
 * toolbar squircle badges, and tab focusing.
 */

// In-memory tab states: tabId -> state object
const tabStates = new Map();
let lastActivePlexTabId = null;

const DYNAMIC_SCRIPT_ID = 'playkeys-custom-origins';

// Badge appearance definitions
const BADGE_COLORS = {
  PLAY_BG: '#E5A00D',      // Plex Amber Gold
  PLAY_TEXT: '#000000',    // Solid Black for play
  PAUSE_BG: '#E53935',     // Vibrant Red for pause distinction
  PAUSE_TEXT: '#FFFFFF'    // Crisp White for pause bars
};

/**
 * Get all configured custom origins from storage
 */
async function getConfiguredCustomOrigins() {
  try {
    const data = await chrome.storage.sync.get({ customOrigins: [] });
    return data.customOrigins || [];
  } catch (err) {
    console.warn('[Playkeys Background] Storage access error:', err);
    return [];
  }
}

/**
 * Determine if a URL is a recognized Plex URL
 */
async function isPlexUrl(url) {
  if (!url) return false;
  if (/^https?:\/\/app\.plex\.tv\//i.test(url)) return true;

  const customOrigins = await getConfiguredCustomOrigins();
  for (const origin of customOrigins) {
    const regexStr = '^' + origin.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    if (new RegExp(regexStr).test(url)) {
      return true;
    }
  }

  // Also recognize local Plex servers if navigated to web client
  if (url.includes(':32400/web') || url.includes('/web/index.html#!/')) {
    return true;
  }

  return false;
}

/**
 * Update toolbar squircle badge according to current playback state
 */
async function updateToolbarBadge(tabId, state) {
  if (!state || !state.hasMedia || (state.isPaused && !state.isPlaying && state.currentTime === 0)) {
    // Clear completely when stopped or no media
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Playkeys (Idle)' });
    return;
  }

  if (state.isPlaying) {
    // Squircle badge: Play indicator (Amber/Orange background, black triangle filling squircle with balanced margins)
    await chrome.action.setBadgeText({ text: '▶' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.PLAY_BG });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: BADGE_COLORS.PLAY_TEXT });
    }
    const metaTitle = state.title ? `${state.title}${state.artist ? ' - ' + state.artist : ''}` : 'Playing';
    await chrome.action.setTitle({ title: `Playkeys: ▶ ${metaTitle}` });
  } else if (state.isPaused) {
    // Squircle badge: Pause indicator (Single solid red background, same-sized squircle, vertically centered white bars spaced 2px apart)
    await chrome.action.setBadgeText({ text: '\u0964\u0964' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.PAUSE_BG });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: BADGE_COLORS.PAUSE_TEXT });
    }
    const metaTitle = state.title ? `${state.title}${state.artist ? ' - ' + state.artist : ''}` : 'Paused';
    await chrome.action.setTitle({ title: `Playkeys: ⏸ ${metaTitle}` });
  }
}

/**
 * Refresh badge using the most relevant tab state
 */
async function refreshGlobalBadge() {
  const bestTab = await discoverBestPlexTab();
  if (!bestTab) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Playkeys (No Plex tab open)' });
    return;
  }

  const state = tabStates.get(bestTab.id);
  if (state) {
    await updateToolbarBadge(bestTab.id, state);
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Playkeys' });
  }
}

/**
 * Ensure content scripts are running in the target Plex tab
 */
async function ensureScriptsInjected(tabId) {
  try {
    // Test if content script responds
    await chrome.tabs.sendMessage(tabId, { action: 'getState' });
  } catch {
    // If not responding, inject main bridge and content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content/content.js']
      });
      // Short delay for initialization
      await new Promise(r => setTimeout(r, 120));
    } catch (err) {
      console.warn('[Playkeys Background] Auto-inject notice for tab', tabId, err.message);
    }
  }
}

/**
 * Inject content script into all currently open Plex tabs (e.g. after extension install/reload)
 */
async function injectIntoAllOpenPlexTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && (await isPlexUrl(tab.url))) {
        await ensureScriptsInjected(tab.id);
      }
    }
  } catch (err) {
    console.warn('[Playkeys Background] Batch injection notice:', err);
  }
}

/**
 * Tab Discovery: Find the most appropriate Plex tab
 * 1. Currently playing tab
 * 2. Tab with active media/metadata
 * 3. Most recently active Plex tab
 * 4. Any open Plex tab
 */
async function discoverBestPlexTab() {
  // 1. Check tabs currently playing
  for (const [tabId, state] of tabStates.entries()) {
    if (state.isPlaying) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab) return tab;
      } catch {
        tabStates.delete(tabId);
      }
    }
  }

  // 2. Check last active Plex tab
  if (lastActivePlexTabId) {
    try {
      const tab = await chrome.tabs.get(lastActivePlexTabId);
      if (tab) return tab;
    } catch {
      lastActivePlexTabId = null;
    }
  }

  // 3. Query all open tabs and find matching Plex tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (await isPlexUrl(tab.url)) {
      await ensureScriptsInjected(tab.id);
      return tab;
    }
  }

  return null;
}

/**
 * Focus the window and tab containing Plex
 */
async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;

    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch (err) {
    console.warn('[Playkeys Background] Focus tab error:', err);
    return false;
  }
}

/**
 * Send an action command to the active Plex tab
 */
async function dispatchPlayerAction(actionName, value = null) {
  const tab = await discoverBestPlexTab();
  if (!tab) {
    console.log('[Playkeys Background] No active Plex tab found for command:', actionName);
    return { success: false, error: 'No Plex tab found' };
  }

  await ensureScriptsInjected(tab.id);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: actionName,
      value: value
    });
    return response;
  } catch (err) {
    console.warn('[Playkeys Background] Action dispatch failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Global Keyboard Shortcuts Router (chrome.commands)
 */
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Playkeys Background] Command received:', command);

  switch (command) {
    case 'play_pause':
      await dispatchPlayerAction('playPause');
      break;
    case 'next_track':
      await dispatchPlayerAction('next');
      break;
    case 'prev_track':
      await dispatchPlayerAction('previous');
      break;
    case 'stop_playback':
      await dispatchPlayerAction('stop');
      break;
    case 'volume_up':
      await dispatchPlayerAction('volumeUp');
      break;
    case 'volume_down':
      await dispatchPlayerAction('volumeDown');
      break;
    case 'toggle_mute':
      await dispatchPlayerAction('toggleMute');
      break;
    default:
      console.warn('[Playkeys Background] Unknown command:', command);
  }
});

/**
 * Message Listener: Synchronize state updates, handle popup requests
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'PLEX_STATE_UPDATE': {
      if (tabId) {
        tabStates.set(tabId, message.state);
        lastActivePlexTabId = tabId;
        updateToolbarBadge(tabId, message.state);
      }
      sendResponse({ received: true });
      break;
    }

    case 'PLEX_TAB_CLOSING': {
      if (tabId) {
        tabStates.delete(tabId);
        if (lastActivePlexTabId === tabId) {
          lastActivePlexTabId = null;
        }
      }
      refreshGlobalBadge();
      sendResponse({ received: true });
      break;
    }

    case 'GET_ACTIVE_PLEX_TAB': {
      (async () => {
        const tab = await discoverBestPlexTab();
        if (!tab) {
          // Check if there are any un-granted Plex servers open in tabs (e.g. localhost:32400)
          const allTabs = await chrome.tabs.query({});
          const unconfiguredPlexTab = allTabs.find(t => t.url && (t.url.includes(':32400') || t.url.includes('/web/index.html')));

          sendResponse({
            tab: null,
            state: null,
            unconfiguredTab: unconfiguredPlexTab ? { id: unconfiguredPlexTab.id, url: unconfiguredPlexTab.url } : null
          });
          return;
        }

        let state = tabStates.get(tab.id) || null;
        if (!state) {
          try {
            state = await chrome.tabs.sendMessage(tab.id, { action: 'getState' });
            if (state) tabStates.set(tab.id, state);
          } catch {
            // Script initializing
          }
        }

        sendResponse({ tab: { id: tab.id, title: tab.title, url: tab.url }, state });
      })();
      return true; // Keep message channel open for async response
    }

    case 'EXECUTE_PLAYER_ACTION': {
      (async () => {
        const result = await dispatchPlayerAction(message.action, message.value);
        sendResponse(result);
      })();
      return true;
    }

    case 'FOCUS_PLEX_TAB': {
      (async () => {
        const targetTabId = message.tabId || (await discoverBestPlexTab())?.id;
        if (targetTabId) {
          const ok = await focusTab(targetTabId);
          sendResponse({ success: ok });
        } else {
          sendResponse({ success: false, error: 'No tab found' });
        }
      })();
      return true;
    }

    case 'SYNC_CUSTOM_ORIGINS': {
      (async () => {
        await updateDynamicContentScripts();
        await injectIntoAllOpenPlexTabs();
        sendResponse({ success: true });
      })();
      return true;
    }
  }
});

/**
 * Register dynamic content script for granted custom origins
 */
async function updateDynamicContentScripts() {
  const customOrigins = await getConfiguredCustomOrigins();
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
    return;
  }

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    }

    if (customOrigins.length > 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: DYNAMIC_SCRIPT_ID,
          matches: customOrigins,
          js: ['content/content.js'],
          runAt: 'document_idle'
        }
      ]);
      console.log('[Playkeys Background] Dynamic origins registered:', customOrigins);
    }
  } catch (err) {
    console.warn('[Playkeys Background] Dynamic script registration notice:', err);
  }
}

/**
 * Tab cleanup listeners
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.has(tabId)) {
    tabStates.delete(tabId);
    if (lastActivePlexTabId === tabId) {
      lastActivePlexTabId = null;
    }
    refreshGlobalBadge();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const isPlex = await isPlexUrl(changeInfo.url);
    if (!isPlex && tabStates.has(tabId)) {
      tabStates.delete(tabId);
      refreshGlobalBadge();
    } else if (isPlex && changeInfo.status === 'complete') {
      await ensureScriptsInjected(tabId);
    }
  }
});

// Initialization on startup / install
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Playkeys Background] Installed / Updated');
  await updateDynamicContentScripts();
  await injectIntoAllOpenPlexTabs();
  await refreshGlobalBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateDynamicContentScripts();
  await injectIntoAllOpenPlexTabs();
  await refreshGlobalBadge();
});
