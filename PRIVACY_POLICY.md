# Privacy Policy for Playkeys for Plex Web

**Last Updated:** October 16, 2026

Playkeys for Plex Web ("the Extension") is an open-source Manifest V3 browser extension designed to provide global keyboard shortcuts, playback indicators, and media flyout controls specifically for Plex Web (`app.plex.tv`) and user-authorized custom Plex Media Servers.

We believe that privacy is a fundamental right. Playkeys is built with a strict **Zero-Data Collection** policy and adheres strictly to the Principle of Least Privilege and Google Chrome Web Store Developer Program Policies.

---

## 1. Zero Data Collection & Non-Transmission

Playkeys **does NOT collect, record, track, transmit, or monetize any user data**.
Specifically:
- **No Personal Information:** We do not collect names, email addresses, IP addresses, Plex account credentials, or tokens.
- **No Browsing History:** We do not track websites visited or history outside of detecting the active Plex Web tab for playback routing.
- **No Media Consumption Analytics:** We do not track, log, or store what you watch or listen to. Media metadata (track title, artist, album, duration, artwork) is queried strictly in real-time in memory to populate the local popup UI and toolbar badge.
- **No Third-Party Telemetry:** Playkeys contains zero third-party analytics (no Google Analytics, Mixpanel, Sentry, etc.), zero advertising networks, zero cookies, and zero external trackers.

All operations and messaging occur 100% locally on your machine between your browser tabs and the background service worker.

---

## 2. Chrome Permissions & Principle of Least Privilege

Playkeys requests only the absolute minimum permissions necessary to fulfill its core functionality:

| Permission | Scope | Justification & Usage |
| :--- | :--- | :--- |
| `commands` | Global / Browser | Enables native media keyboard shortcuts (`MediaPlayPause`, `MediaNextTrack`, `MediaPrevTrack`, `MediaStop`, and volume keys) to control Plex Web even when minimized. |
| `storage` | Local (`chrome.storage.sync`) | Persists your configured custom server origins and UI preferences across your synchronized browser sessions. No personal data is stored. |
| `tabs` | Local | Identifies open tabs running Plex Web to forward media commands and support one-click window focusing from the popup flyout. |
| `scripting` | Dynamic Injection | Dynamically registers content scripts on custom Plex Media Server origins that you explicitly authorize at runtime. |
| `host_permissions` (`https://app.plex.tv/*`) | Scoped | Grants access only to the official Plex Web client to read media status and simulate playback actions. |
| `optional_host_permissions` (`*://*/*`) | Dynamic / On-Demand | Allows you to selectively grant origin access to your self-hosted Plex server (e.g., `http://192.168.1.100:32400/*` or `http://localhost:32400/*`) via Chrome's native `chrome.permissions.request` prompt without blanket permissions. |

---

## 3. Data Storage & Management

- Any custom server URLs you configure are stored securely in your browser's `chrome.storage.sync` storage area.
- You can review, modify, or permanently delete custom servers and revoke their origin permissions at any time through the **Playkeys Options Page**.
- Uninstalling the Extension completely purges all stored preferences and revoked permissions immediately.

---

## 4. Trademark Notice & Disclaimer

- **Plex** is a registered trademark of Plex, Inc.
- **Playkeys** is an independently developed open-source project and is not affiliated with, endorsed by, sponsored by, or associated in any way with Plex, Inc.
- References to "Plex" or "Plex Web" are made strictly for descriptive compatibility purposes in accordance with trademark fair use guidelines and Chrome Web Store Developer Program Policies.

---

## 5. Compliance with Google Chrome Web Store Policies

- **Single Purpose:** Playkeys has a single, transparent purpose: providing keyboard media controls, playback badges, and flyout management for Plex Web players.
- **Limited Use Disclosure:** Use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.
- **No Remote Code Execution:** All code is bundled within the extension package; no remote scripts, external CDNs, or obfuscated evaluation scripts are used.

---

## 6. Open Source Transparency & License

Playkeys is released under the permissive MIT License. The complete source code is fully transparent, auditable, and unminified for complete peer inspection.
