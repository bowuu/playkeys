/**
 * Playkeys - Shared Server Origin Utilities
 * Normalizes custom Plex server URLs, matches Chrome origin patterns,
 * and persists custom server configurations in chrome.storage.sync.
 */

/**
 * Check whether a URL points to the official Plex Web app.
 * @param {string} url
 * @returns {boolean}
 */
export function isOfficialPlexUrl(url) {
  return typeof url === 'string' && /^https:\/\/app\.plex\.tv(\/|$)/i.test(url);
}

/**
 * Convert user-entered server URL into a Chrome MV3 match pattern and metadata.
 * Chrome match patterns omit port numbers: <scheme>://<hostname>/*
 * @param {string} rawInput
 * @returns {{ pattern: string, displayName: string, displayUrl: string, hostname: string }}
 */
export function normalizeServerInput(rawInput) {
  let urlString = String(rawInput || '').trim();
  if (!urlString) {
    throw new Error('Please enter a server URL.');
  }

  if (!/^https?:\/\//i.test(urlString)) {
    urlString = 'http://' + urlString;
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    throw new Error(`Invalid URL format: ${err.message}`);
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('Only http and https protocols are supported.');
  }

  if (!parsed.hostname) {
    throw new Error('Invalid URL format: missing hostname.');
  }

  const pattern = `${scheme}://${parsed.hostname}/*`;
  const displayName = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const displayUrl = parsed.origin + (parsed.pathname !== '/' ? parsed.pathname : '');

  return {
    pattern,
    displayName,
    displayUrl,
    hostname: parsed.hostname
  };
}

/**
 * Match a tab URL against a Chrome extension match pattern (ignoring port, per Chrome semantics).
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesOriginPattern(url, pattern) {
  if (!url || !pattern) return false;
  if (pattern === '<all_urls>') return /^https?:\/\//i.test(url);

  const match = /^(https?|\*):\/\/([^/]+)\/(.*)$/i.exec(pattern);
  if (!match) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const [, patScheme, patHost, patPath] = match;
  const urlScheme = parsed.protocol.replace(':', '').toLowerCase();

  if (patScheme === '*') {
    if (urlScheme !== 'http' && urlScheme !== 'https') return false;
  } else if (patScheme.toLowerCase() !== urlScheme) {
    return false;
  }

  const urlHost = parsed.hostname.toLowerCase();
  const targetHost = patHost.toLowerCase();
  if (targetHost.startsWith('*.')) {
    const baseDomain = targetHost.slice(2);
    if (urlHost !== baseDomain && !urlHost.endsWith('.' + baseDomain)) {
      return false;
    }
  } else if (targetHost !== '*' && urlHost !== targetHost) {
    return false;
  }

  if (patPath === '*') return true;

  const fullPath = parsed.pathname + parsed.search;
  const pathRegex = new RegExp(
    '^/' + patPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return pathRegex.test(fullPath);
}

/**
 * Save or update a custom server entry in chrome.storage.sync.
 * @param {{ pattern: string, displayName: string, displayUrl: string }} normalized
 * @returns {Promise<{ added: boolean, updated: boolean, server: object }>}
 */
export async function saveCustomServer(normalized) {
  const data = await chrome.storage.sync.get({ customServers: [], customOrigins: [] });
  const servers = Array.isArray(data.customServers) ? [...data.customServers] : [];
  const origins = Array.isArray(data.customOrigins) ? [...data.customOrigins] : [];

  if (!origins.includes(normalized.pattern)) {
    origins.push(normalized.pattern);
  }

  const existingIndex = servers.findIndex((s) => s.pattern === normalized.pattern);
  if (existingIndex !== -1) {
    const existing = servers[existingIndex];
    const updatedServer = {
      ...existing,
      displayName: normalized.displayName,
      displayUrl: normalized.displayUrl,
      name: `Plex Server (${normalized.displayName})`
    };
    servers[existingIndex] = updatedServer;
    await chrome.storage.sync.set({ customServers: servers, customOrigins: origins });
    return { added: false, updated: true, server: updatedServer };
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
  await chrome.storage.sync.set({ customServers: servers, customOrigins: origins });
  return { added: true, updated: false, server: newServer };
}
