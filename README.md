# Playkeys for Plex Web 🎬

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Pure%20Vanilla)-brightgreen?style=flat-square)](manifest.json)
[![Store Policy Compliant](https://img.shields.io/badge/CWS-Trademark%20Compliant-brightgreen?style=flat-square)](PRIVACY_POLICY.md)

> A modern, zero-dependency Manifest V3 Chrome extension designed specifically for Plex Web (`app.plex.tv`) and self-hosted Plex Media Servers. Control playback seamlessly with global keyboard shortcuts, native toolbar squircle badges, and an intuitive dark-themed popup flyout.

---

## ⚖️ Trademark Disclaimer

**Plex** is a registered trademark of Plex, Inc. **Playkeys** is an independently developed open-source browser extension and is **not affiliated with, endorsed by, sponsored by, or associated with Plex, Inc.** All references to "Plex" or "Plex Web" are made solely for descriptive compatibility purposes in strict compliance with Google Chrome Web Store Developer Program Policies.

---

## ✨ Features

- **🌐 Global Keyboard Shortcuts:**
  - Control playback seamlessly from anywhere on your operating system using hardware media keys (`MediaPlayPause`, `MediaNextTrack`, `MediaPrevTrack`, `MediaStop`) and dedicated volume shortcuts.
- **🏷️ Squircle Toolbar Badges:**
  - Dynamic toolbar status indicators overlaid cleanly on your extension icon:
    - **Playing:** Solid Plex Amber `#E5A00D` squircle with a prominent black play triangle (`▶`).
    - **Paused:** Solid vibrant red `#E53935` squircle with crisp, vertically centered white pause bars (`।।`).
  - Automatically and completely clears badge text and tooltip when playback finishes, is stopped, or the media tab closes.
- **🎛️ Dark-Themed Popup Flyout:**
  - **Single-row controls:** Shuffle, Previous, Play/Pause (prominent hero button), Next, Repeat.
  - **Scrubbable timeline seek bar:** Real-time visual progress gradient with responsive drag-and-seek.
  - **Volume & Mute:** Interactive volume slider with percentage readout and quick mute toggle.
  - **Track Artwork & Metadata:** High-resolution cover art, title, artist, and album fetched in real time.
  - **One-Click Tab Focus:** Quick `[ ↗ ]` button to instantly focus your active Plex tab and browser window.
  - **Auto-Detect Local Servers:** Detects open local Plex tabs and offers instant 1-click connection.
- **🛡️ Principle of Least Privilege:**
  - Scoped by default strictly to official Plex Web (`https://app.plex.tv/*`).
  - Zero broad `<all_urls>` host permissions requested on install.
- **🔌 Dynamic Origin Permission Requests:**
  - Connect custom local servers (e.g., `http://192.168.1.100:32400/web`, `http://localhost:32400`) on demand via Chrome's native runtime permission prompt.
- **🔒 Zero-Data Collection:**
  - No analytics, no telemetry, no tracking, no ads, and zero external network calls. All processing runs 100% locally in your browser.

---

## ⌨️ Default Keyboard Shortcuts

| Action | Shortcut | Scope | Description |
| :--- | :--- | :--- | :--- |
| **Play / Pause** | `MediaPlayPause` | **Global** | Play or pause playback in active Plex tab |
| **Next Track** | `MediaNextTrack` | **Global** | Skip to next track or episode |
| **Previous Track** | `MediaPrevTrack` | **Global** | Return to previous track or restart current |
| **Stop Playback** | `MediaStop` | **Global** | Pause playback and clear toolbar badge |
| **Volume Up** | `Alt` + `Shift` + `↑` | In Chrome | Increase Plex volume by +5% |
| **Volume Down** | `Alt` + `Shift` + `↓` | In Chrome | Decrease Plex volume by -5% |
| **Toggle Mute** | `Alt` + `Shift` + `M` | In Chrome | Mute / unmute audio |

> **Customizing Shortcuts:** Navigate to `chrome://extensions/shortcuts` in Google Chrome to rebind any shortcut or toggle between **Global** (system-wide) and **In Chrome** behavior.

---

## 🚀 Installation & Setup

Playkeys is built with zero build steps and zero dependencies. No Node.js, npm, or bundlers are required.

### Loading Unpacked in Chrome (Developer Mode)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/your-username/playkeys.git
   ```
2. Open Google Chrome and go to:
   ```
   chrome://extensions
   ```
3. Enable the **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the root `playkeys` directory containing `manifest.json`.
6. Click the Extensions (puzzle piece) icon in your Chrome toolbar and **pin Playkeys** for easy access.

---

## 🖥️ Connecting Custom Plex Servers

By default, Playkeys is active on official Plex Web (`https://app.plex.tv/*`). To connect a local or custom-domain server:

1. Open the Playkeys popup flyout and click the **Settings Cog (⚙)** (or right-click the extension icon and select **Options**).
2. Under **Plex Servers**, enter your server address, for example:
   - `http://192.168.1.100:32400/web`
   - `http://localhost:32400`
   - `https://plex.example.com`
3. Click **Request Permission & Add**.
4. When prompted by Chrome, click **Allow** to grant origin permissions.
5. Playkeys will automatically begin controlling playback on your custom server.

---

## 📁 Repository Structure

```
playkeys/
├── manifest.json            # Manifest V3 extension configuration
├── LICENSE                  # MIT License
├── PRIVACY_POLICY.md        # Comprehensive zero-data privacy policy
├── README.md                # Public documentation & setup guide
├── icons/                   # Extension icons (SVG source and 16, 32, 48, 128 PNGs)
├── background/
│   └── background.js        # Service worker for tab discovery, commands, and badges
├── content/
│   ├── main-bridge.js       # Page-context MediaSession bridge (world: MAIN)
│   └── content.js           # DOM controller and media synchronizer (world: ISOLATED)
├── popup/
│   ├── popup.html           # Dark-themed media player flyout
│   ├── popup.css            # Popup styling
│   └── popup.js             # Player UI controller and timeline seek handler
└── options/
    ├── options.html         # Server origin configuration & shortcut guide
    ├── options.css          # Options styling
    └── options.js           # Dynamic origin permission manager
```

---

## 🛡️ Privacy & Security

Playkeys is built on the **Principle of Least Privilege**:
* **100% Local:** No user data, listening history, or account details are collected, logged, or transmitted anywhere.
* **No Remote Scripts:** No remote code execution, external CDNs, or `eval()` calls. All scripts run entirely from local extension files.
* For complete details, see [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

---

## 📄 License

This project is licensed under the permissive **[MIT License](LICENSE)**.


---

## 🤖 AI Agent & Developer Guidelines

Operational rulebooks, architectural patterns, DirectWrite badge kerning specifications, and Chrome Web Store guidelines for AI pair programmers (e.g. Antigravity) are maintained in the private vault:
👉 **[`bowuu/agent-rules`](https://github.com/bowuu/agent-rules)** (`repos/playkeys/AGENTS.md`)

To sync local guidelines across devices, clone the private vault alongside this project and run:
```powershell
cd agent-rules
.\sync.ps1 -Action deploy
```
