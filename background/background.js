/**
 * Playkeys - Background Service Worker (Manifest V3)
 * Handles tab discovery, session state persistence, auto-injection,
 * command routing, toolbar squircle badges, and tab focusing.
 */

import { isOfficialPlexUrl, matchesOriginPattern } from '../shared/servers.js';

// In-memory cache hydrated from chrome.storage.session on service worker wake-up
const tabStates = new Map();
let lastActivePlexTabId = null;
let sessionLoaded = false;
let sessionLoadPromise = null;

const DYNAMIC_SCRIPT_MAIN_ID = 'playkeys-custom-origins-main';
const DYNAMIC_SCRIPT_ISOLATED_ID = 'playkeys-custom-origins-isolated';
const LEGACY_DYNAMIC_SCRIPT_ID = 'playkeys-custom-origins';

// Serialized promise chain for toolbar badge updates to avoid race conditions
let badgeQueue = Promise.resolve();

// Badge appearance definitions
const BADGE_COLORS = {
  PLAY_BG: '#E5A00D',      // Plex Amber Gold
  PLAY_TEXT: '#000000',    // Solid Black for play
  PAUSE_BG: '#E53935',     // Vibrant Red for pause distinction
  PAUSE_TEXT: '#FFFFFF'    // Crisp White for pause bars
};

/**
 * Hydrate tabStates and lastActivePlexTabId from chrome.storage.session
 */
async function ensureSessionLoaded() {
  if (sessionLoaded) return;
  if (sessionLoadPromise) return sessionLoadPromise;

  sessionLoadPromise = (async () => {
    try {
      if (chrome.storage.session) {
        const data = await chrome.storage.session.get({
          sessionTabStates: {},
          lastActivePlexTabId: null
        });
        for (const [idStr, state] of Object.entries(data.sessionTabStates || {})) {
          const id = Number(idStr);
          if (Number.isInteger(id) && state) {
            tabStates.set(id, state);
          }
        }
        if (Number.isInteger(data.lastActivePlexTabId)) {
          lastActivePlexTabId = data.lastActivePlexTabId;
        }
      }
    } catch (err) {
      console.warn('[Playkeys Background] Session load error:', err);
    } finally {
      sessionLoaded = true;
      sessionLoadPromise = null;
    }
  })();

  return sessionLoadPromise;
}

/**
 * Persist tabStates and lastActivePlexTabId to chrome.storage.session
 */
async function persistSessionState() {
  try {
    if (!chrome.storage.session) return;
    const serialized = {};
    for (const [tabId, state] of tabStates.entries()) {
      serialized[String(tabId)] = state;
    }
    await chrome.storage.session.set({
      sessionTabStates: serialized,
      lastActivePlexTabId
    });
  } catch (err) {
    console.warn('[Playkeys Background] Session persist error:', err);
  }
}

/**
 * Get configured custom origins whose runtime host permissions are currently granted
 */
async function getGrantedCustomOrigins() {
  try {
    const data = await chrome.storage.sync.get({ customOrigins: [] });
    const configured = Array.isArray(data.customOrigins) ? data.customOrigins : [];
    if (configured.length === 0) return [];

    const granted = [];
    for (const origin of configured) {
      try {
        const ok = await chrome.permissions.contains({ origins: [origin] });
        if (ok) granted.push(origin);
      } catch {
        // Ignore malformed pattern
      }
    }
    return granted;
  } catch (err) {
    console.warn('[Playkeys Background] Storage access error:', err);
    return [];
  }
}

/**
 * Determine if a URL is an authorized Plex Web URL (official or granted custom origin)
 */
async function isConfiguredPlexUrl(url) {
  if (!url) return false;
  if (isOfficialPlexUrl(url)) return true;

  const customOrigins = await getGrantedCustomOrigins();
  return customOrigins.some((origin) => matchesOriginPattern(url, origin));
}

/**
 * Detect tabs that look like a local/self-hosted Plex server without granted permissions
 */
function isLikelyUnconfiguredPlexUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return url.includes(':32400') || url.includes('/web/index.html');
}

/**
 * Serialize badge updates to keep icon text, background color, and title consistent
 */
function enqueueBadgeUpdate(task) {
  badgeQueue = badgeQueue.then(task).catch((err) => {
    console.warn('[Playkeys Background] Badge update notice:', err);
  });
  return badgeQueue;
}

/**
 * Apply toolbar squircle badge state
 */
async function applyToolbarBadge(state, emptyTitle = 'Playkeys (Idle)') {
  if (!state || !state.hasMedia || (state.isPaused && !state.isPlaying && state.currentTime === 0)) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: emptyTitle });
    return;
  }

  if (state.isPlaying) {
    await chrome.action.setBadgeText({ text: '▶' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.PLAY_BG });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: BADGE_COLORS.PLAY_TEXT });
    }
    const metaTitle = state.title ? `${state.title}${state.artist ? ' - ' + state.artist : ''}` : 'Playing';
    await chrome.action.setTitle({ title: `Playkeys: ▶ ${metaTitle}` });
  } else if (state.isPaused) {
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
 * Verify a tab still exists and points to a configured Plex URL
 */
async function getValidPlexTab(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && (await isConfiguredPlexUrl(tab.url))) {
      return tab;
    }
  } catch {
    // Tab closed
  }
  tabStates.delete(tabId);
  if (lastActivePlexTabId === tabId) {
    lastActivePlexTabId = null;
  }
  return null;
}

/**
 * Pick the highest-priority tab from cached tabStates without probing all browser tabs
 */
async function findBestCachedPlexTab() {
  await ensureSessionLoaded();

  const orderedIds = Array.from(tabStates.keys());
  if (lastActivePlexTabId && tabStates.has(lastActivePlexTabId)) {
    orderedIds.sort((a, b) => (a === lastActivePlexTabId ? -1 : b === lastActivePlexTabId ? 1 : 0));
  }

  // Priority 1: Playing tab
  for (const tabId of orderedIds) {
    const state = tabStates.get(tabId);
    if (state?.isPlaying) {
      const tab = await getValidPlexTab(tabId);
      if (tab) return tab;
    }
  }

  // Priority 2: Paused tab with active media
  for (const tabId of orderedIds) {
    const state = tabStates.get(tabId);
    if (state?.hasMedia) {
      const tab = await getValidPlexTab(tabId);
      if (tab) return tab;
    }
  }

  // Priority 3: Last active Plex tab
  if (lastActivePlexTabId) {
    const tab = await getValidPlexTab(lastActivePlexTabId);
    if (tab) return tab;
  }

  return null;
}

/**
 * Refresh the global toolbar badge using the highest-priority active Plex tab
 */
async function refreshGlobalBadge() {
  return enqueueBadgeUpdate(async () => {
    const bestTab = await findBestCachedPlexTab();
    if (bestTab) {
      const state = tabStates.get(bestTab.id) || null;
      await applyToolbarBadge(state, 'Playkeys (Idle)');
      return;
    }

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (await isConfiguredPlexUrl(tab.url)) {
        await applyToolbarBadge(tabStates.get(tab.id) || null, 'Playkeys');
        return;
      }
    }

    await applyToolbarBadge(null, 'Playkeys (No Plex tab open)');
  });
}

/**
 * Ensure both main-world bridge and isolated content script are running in the target tab
 */
async function ensureScriptsInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'getState' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/main-bridge.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
        world: 'ISOLATED'
      });
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      console.warn('[Playkeys Background] Auto-inject notice for tab', tabId, err.message);
    }
  }
}

/**
 * Inject content scripts into all currently open authorized Plex tabs
 */
async function injectIntoAllOpenPlexTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && (await isConfiguredPlexUrl(tab.url))) {
        await ensureScriptsInjected(tab.id);
      }
    }
  } catch (err) {
    console.warn('[Playkeys Background] Batch injection notice:', err);
  }
}

/**
 * Tab Discovery: Find the most appropriate authorized Plex tab
 * 1. Currently playing tab
 * 2. Tab with active/paused media
 * 3. Most recently active Plex tab
 * 4. Probe open Plex tabs to pick active playback or most recent open tab
 */
async function discoverBestPlexTab() {
  const cachedBest = await findBestCachedPlexTab();
  if (cachedBest) return cachedBest;

  const tabs = await chrome.tabs.query({});
  const plexTabs = [];
  for (const tab of tabs) {
    if (tab.id && (await isConfiguredPlexUrl(tab.url))) {
      plexTabs.push(tab);
    }
  }

  if (plexTabs.length === 0) return null;

  // Probe tabs to rebuild state when service worker woke cold
  for (const tab of plexTabs) {
    await ensureScriptsInjected(tab.id);
    try {
      const state = await chrome.tabs.sendMessage(tab.id, { action: 'getState' });
      if (state) {
        tabStates.set(tab.id, state);
      }
    } catch {
      // Ignore unready tab
    }
  }
  await persistSessionState();

  const probedBest = await findBestCachedPlexTab();
  if (probedBest) return probedBest;

  // Fallback: prefer an active tab in its window, otherwise first open Plex tab
  return plexTabs.find((t) => t.active) || plexTabs[0];
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
    return await chrome.tabs.sendMessage(tab.id, {
      action: actionName,
      value
    });
  } catch (err) {
    console.warn('[Playkeys Background] Action dispatch failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Global Keyboard Shortcuts Router (chrome.commands)
 */
chrome.commands.onCommand.addListener(async (command) => {
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
 * Message Listener: Synchronize state updates, handle popup & options requests
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'PLEX_STATE_UPDATE': {
      (async () => {
        await ensureSessionLoaded();
        if (tabId) {
          tabStates.set(tabId, message.state);
          const anotherTabPlaying = Array.from(tabStates.entries()).some(
            ([id, st]) => id !== tabId && st?.isPlaying
          );
          if (message.state?.isPlaying || message.state?.hasMedia || !anotherTabPlaying) {
            lastActivePlexTabId = tabId;
          }
          await persistSessionState();
          await refreshGlobalBadge();
        }
        sendResponse({ received: true });
      })();
      return true;
    }

    case 'PLEX_TAB_CLOSING': {
      (async () => {
        await ensureSessionLoaded();
        if (tabId) {
          tabStates.delete(tabId);
          if (lastActivePlexTabId === tabId) {
            lastActivePlexTabId = null;
          }
          await persistSessionState();
          await refreshGlobalBadge();
        }
        sendResponse({ received: true });
      })();
      return true;
    }

    case 'GET_ACTIVE_PLEX_TAB': {
      (async () => {
        const tab = await discoverBestPlexTab();
        if (!tab) {
          const allTabs = await chrome.tabs.query({});
          let unconfiguredPlexTab = null;
          for (const t of allTabs) {
            if (t.url && isLikelyUnconfiguredPlexUrl(t.url) && !(await isConfiguredPlexUrl(t.url))) {
              unconfiguredPlexTab = t;
              break;
            }
          }

          sendResponse({
            tab: null,
            state: null,
            unconfiguredTab: unconfiguredPlexTab
              ? { id: unconfiguredPlexTab.id, url: unconfiguredPlexTab.url }
              : null
          });
          return;
        }

        let state = tabStates.get(tab.id) || null;
        if (!state) {
          try {
            state = await chrome.tabs.sendMessage(tab.id, { action: 'getState' });
            if (state) {
              tabStates.set(tab.id, state);
              await persistSessionState();
            }
          } catch {
            // Script initializing
          }
        }

        sendResponse({ tab: { id: tab.id, title: tab.title, url: tab.url }, state });
      })();
      return true;
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
        await refreshGlobalBadge();
        sendResponse({ success: true });
      })();
      return true;
    }
  }
});

/**
 * Register dynamic MAIN and ISOLATED content scripts for granted custom origins
 */
async function updateDynamicContentScripts() {
  const customOrigins = await getGrantedCustomOrigins();
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
    return;
  }

  try {
    const idsToCheck = [DYNAMIC_SCRIPT_MAIN_ID, DYNAMIC_SCRIPT_ISOLATED_ID, LEGACY_DYNAMIC_SCRIPT_ID];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: idsToCheck });
    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: existing.map((item) => item.id)
      });
    }

    if (customOrigins.length > 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: DYNAMIC_SCRIPT_MAIN_ID,
          matches: customOrigins,
          js: ['content/main-bridge.js'],
          world: 'MAIN',
          runAt: 'document_start'
        },
        {
          id: DYNAMIC_SCRIPT_ISOLATED_ID,
          matches: customOrigins,
          js: ['content/content.js'],
          world: 'ISOLATED',
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
 * Tab cleanup and navigation listeners
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureSessionLoaded();
  if (tabStates.has(tabId) || lastActivePlexTabId === tabId) {
    tabStates.delete(tabId);
    if (lastActivePlexTabId === tabId) {
      lastActivePlexTabId = null;
    }
    await persistSessionState();
    await refreshGlobalBadge();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureSessionLoaded();

  if (changeInfo.url) {
    const isPlex = await isConfiguredPlexUrl(changeInfo.url);
    if (!isPlex && tabStates.has(tabId)) {
      tabStates.delete(tabId);
      if (lastActivePlexTabId === tabId) {
        lastActivePlexTabId = null;
      }
      await persistSessionState();
      await refreshGlobalBadge();
    }
  }

  if (changeInfo.status === 'complete' && tab?.url && (await isConfiguredPlexUrl(tab.url))) {
    await ensureScriptsInjected(tabId);
  }
});

// Initialization on install / browser startup
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
