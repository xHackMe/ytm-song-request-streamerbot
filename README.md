# THIS IS A TEST VERSION!!! IT MAY CONTAIN FEATURES THAT ARE PARTIALLY OR COMPLETELY NOT WORKING

# 🎵 YTM Song Request for Streamer.bot (v1.2.3T)

A dynamic, self-hosted YouTube Music player and Song Request system built specifically for Streamer.bot. This system runs locally in your browser, uses your own Google API key (no third-party server dependencies), and communicates directly with your chat via Streamer.bot's built-in WebSockets.

Current Streamer.bot import version: `1.2.3T-I2` for page version `v1.2.3T`.

## ✨ Key Features
* **No Third-Party Services:** Runs entirely locally on Streamer.bot's HTTP and WebSocket servers. Your data and API keys stay on your machine.
* **Drag & Drop Queue:** Easily manage viewer requests by dragging and dropping tracks to change their order in real-time.
* **Base Playlists (Fallback):** Add your favorite YouTube playlists. If the viewer queue is empty, the player will automatically shuffle and play tracks from your base playlists.
* **Blacklist / Ban System:** Ban troll songs with one click. Banned songs are instantly skipped and removed.
* **Multi-language Support:** UI and Bot chat responses are available in English, Polish, Ukrainian, German, French, and Turkish.
* **Chat Commands:** Support for standard SR commands (`!sr [link/title]`, `!voteskip`, `!skip`, `!wrongsong`, `!volume`).
* **Auto-Skip:** Automatically skips unavailable, blocked, or deleted videos.
* **Compact widget for OBS:** A standalone floating widget that displays the title and progress of the currently playing song. Perfect for adding to OBS! It uses Web Socket to refresh the status live.
* **Diagnostics & Import Check:** The page can check the active Streamer.bot import and show exactly what is missing when a required import update is needed.
* **Settings Backup:** Export and import local page settings without including the YouTube API key.

supported languages:

English
Polski
Українська
Deutsch
Français
Türkçe

## 📥 Installation & Setup

### Step 1: Download the files
Download the latest `index.html`, `now-playing-widget.html`, `style.css`, `app.js` and `translations.js` or `Source code
(zip)` from the [Releases](https://github.com/xHackMe/ytm-song-request-streamerbot/releases) tab and save them in a dedicated folder on your PC (e.g., `C:\StreamerBot\YTM Song Request\`).

### Step 2: Streamer.bot HTTP Server
The file needs to be hosted locally to bypass browser restrictions and communicate with the API properly.
1. Open Streamer.bot and go to **Servers/Clients -> HTTP Server**.
2. Set the Port (default `7474`).
3. In the **Mappings** section, click the folder icon and select the folder where you saved `index.html`.
4. In the **PATH** field, enter a subfolder name (e.g., `ytm`).
5. Check **Auto Start** and click **Start Server**.
*Your player is now accessible at `http://localhost:7474/ytm/index.html`*

### Step 3: Streamer.bot WebSocket Server
This is required for chat commands to communicate with the web player.
1. In Streamer.bot, go to **Servers/Clients -> WebSockets -> Server**.
2. Set the Port to `8080` (or your preferred port).
3. Check **Auto Start** and click **Start Server**.

### Step 4: Import Actions to Streamer.bot
1. Click the **Import** button at the top of Streamer.bot.
2. Paste the following import code into the *Import String* box and click **Import**:

<details>
<summary><b>CLICK HERE TO SHOW IMPORT CODE</b></summary>

<pre><code>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</code></pre>

</details>

### Step 5: Final Configuration
1. Open your browser and go to `http://localhost:7474/YTM/index.html` (or whatever you set up in Step 2).
2. Follow the built-in, interactive tutorial.
3. You will need a **free YouTube Data API v3 key** from Google Cloud Console (instructions provided inside the app).

### Step 6: Widget (Optional)
1. Open Settings > General > OBS Widget Configuration, copy the generated URL, and paste it into an OBS Browser Source. The link automatically uses your WebSocket port and password settings.
2. Set your preferred resolution. Recommended: 400x200px
3. Use the widget test button in Settings to confirm that OBS receives the widget state.


---
*Created by [HackMe_](https://twitch.tv/HackMe_)*
