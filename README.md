# Lecture Assistant: Chrome extension

Records the sound (and, if you tick it, the picture) of a browser tab, such as an online lecture, and sends it to the
Lecture Assistant server in 5-minute parts while the lecture runs. After you press **Stop**, it sends the last part,
optionally the slides, asks the server to make the notes, and links to them on the website.

Chrome 116 or newer. Plain JavaScript, no build step. The side panel is the user interface, an offscreen document owns the
recorders (so closing the panel never stops a lecture), and the service worker sends the parts.

## Install (for the prototype)

1. `npm run pack` makes `lecturekit-extension.zip` (or use the `lecturekit-extension` folder itself).
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** and choose the unzipped folder.
4. Click the extension icon on the lecture tab: the side panel opens. Log in with your Lecture Assistant account.

The default server is `https://localhost:8443`. Use **Server** on the log-in screen to point it at another address
(Chrome asks you to allow that address once).

## What is in each file

| File | Job |
|---|---|
| `manifest.json` | permissions: `tabCapture`, `offscreen`, `storage`, `sidePanel`, `activeTab`, `alarms` |
| `sidepanel.*` | log in, ready, recording, after stop, processing, done |
| `offscreen.*` | the tab stream, one recorder per part, the recorded-time clock (pause stops it) |
| `background.js` | state machine, upload queue, finishing |
| `lib/chunker.js` | the part schedule (part k covers `k*300-5` to `(k+1)*300` s); pure, unit tested |
| `lib/queue.js` | one part at a time, retries after 2, 5, 15, 30, 60 s, a 401 pauses and keeps every part |
| `lib/store.js` | settings in `chrome.storage`, recorded parts in IndexedDB until the server has them |
| `lib/api.js` | the server calls (same routes and errors as the web app) |

## Tests

```
npm test            # unit tests: part schedule and upload queue
npm run e2e         # loads the real extension in Chromium against a mock server, 10-second parts, made-up stream
```

The automatic test uses a made-up stream because Chrome only allows tab capture after a real click on the toolbar icon.
So the real capture needs a manual check:

- [ ] open a tab that plays sound or video, click the extension icon on that tab, Start: the tab stays audible
- [ ] let it run 11 minutes: parts 1, 2, 3 turn green
- [ ] Pause, wait, Resume: the timer continues, no gap in the notes
- [ ] switch off Wi-Fi for 2 minutes, switch on: all parts arrive
- [ ] close the panel and open it again: recording continues, the timer is right
- [ ] Stop, add slides, Make notes, Open notes shows the notes on the website

## Limits (v1)

- Only the active tab is recorded, never the microphone. Browser pages (`chrome://`) cannot be recorded.
- Pictures of a live recording are not yet read for the notes and there is no replay video for live recordings.
- An account made with Google has no password; set one on the website first (not built yet) or register with an email.
