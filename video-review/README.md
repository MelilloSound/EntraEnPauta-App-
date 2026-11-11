# Video Review

A small app that runs on your computer for reviewing and editing your videos with Claude.

- **Homepage**: all your video projects, newest first.
- **Review**: every clip plays with a timeline. Click the picture to pin a note on the exact spot, or click the timeline to pin it to a moment.
- **Edit it yourself**: split, trim, remove, reorder, change speed, volume and fades, add text and music. It works like CapCut, but simpler.
- **Copy moments**: one button turns every note, plus a precise description of your own edits, into a single prompt you paste into Claude.
- **AAF for Pro Tools**: export the audio with the media embedded, plus a cue sheet and a reference video with burned-in timecode.

It's plain HTML and a small Node server with no dependencies, and it **never deletes, moves or overwrites your files**.

## Easiest way to start

Double-click **Start Video Review.command** (Mac) or **Start Video Review.bat** (Windows). The first time, it installs Node.js if needed, then opens the app in your browser. On a Mac, if it says the file is from an unidentified developer, right-click it and choose **Open**.

---

## Start it

You need [Node.js](https://nodejs.org) 18 or newer. Then, in this folder:

```bash
node server.js
```

Your browser opens at `http://localhost:4747`. Leave the terminal window open while you work, and press `Ctrl+C` to stop.

Projects live in a folder called **Video Review** in your home folder. It's created the first time you start the app. To use another folder:

```bash
node server.js "/Volumes/Work/Client videos"
```

### Optional: ffmpeg

Everything works without it. With [ffmpeg](https://ffmpeg.org) installed, the app can also:

- render your edit to an MP4,
- render a reference video with burned-in timecode next to each AAF,
- make a playable copy of files your browser can't play (ProRes, some HEVC),
- extract audio for AAF exports faster, for any length of video, and time-stretch sped-up parts without changing the pitch.

```bash
brew install ffmpeg          # macOS (with Homebrew)
winget install ffmpeg        # Windows
```

Restart the app afterwards. The homepage shows **ffmpeg ready** when it finds it.

---

## How to use it

### 1. Projects

A project is just a folder of clips. Every folder inside your projects folder appears on the homepage, newest first.

- **New project** creates a folder. Drop video files anywhere on the homepage to create one with those files in it.
- **Add a folder…** uses a folder you already have anywhere else, such as an external drive. Nothing is copied or moved. On a Mac, select the folder in Finder and press `⌥⌘C` to copy its path.
- When Claude saves a new version into the folder, it shows up on its own within a few seconds.

### 2. Review: pin notes on exact moments and spots

Open a project, then pick a clip in the bar at the top.

| To… | Do this |
|---|---|
| Pin a note on a **spot** in the picture | Pause and click the picture |
| Mark an **area** | Drag a box on the picture |
| Pin a note to a **moment** | Click the **Notes** lane on the timeline, or press `C` |
| Cover a **stretch of time** | Drag along the Notes lane, or use **Until playhead** while writing |
| Write about a **specific element** (a piece of video, a text, the music) | Select it on the timeline, then press `C` or click **Note about this** |

Every note saves a **still of that exact frame** with the spot circled. Mark a note as done (✓) once it's fixed.

### 3. Edit it yourself

Your edits don't touch the original file. They describe what you want, so Claude can make the same change in the source project.

| Tool | How |
|---|---|
| Split | Put the playhead where you want to cut and press `S` |
| Remove a piece | Select it, then press `Delete` (it comes off the timeline; your file is untouched) |
| Trim | Drag either edge of a piece |
| Reorder | Drag a piece left or right |
| Speed, volume, mute, fades | Select a piece and use the panel on the right |
| Text | Press `T`, type, then drag the text on the picture to place it |
| Music or voice-over | Press `A` and pick a file. Drag it along its lane or onto another lane |
| Another clip | **Insert clip** puts a whole clip at the playhead |
| Undo / redo | `⌘Z` / `⇧⌘Z` (on Windows: `Ctrl+Z` / `Ctrl+Y`) |

**My edit / Original** (under the picture) switches between your version and the untouched file, so you can compare.

### 4. Copy moments and paste into Claude

Click **Copy moments**. The prompt is copied to your clipboard and shown so you can check it. It has:

- every open note in timeline order, with its time (also the time in your edit if you re-cut the clip), where on the frame you clicked, what it's about, and the path to its still;
- your edits in plain words, for example *"Cut out 00:03.00–00:06.00 of the original"*, *"Speed 1.5× on…"* or *"Added text 'Summer sale' bottom center, yellow, bold…"*;
- your final cut piece by piece, and the exact timeline numbers, so Claude can reproduce the edit precisely;
- a request to save the revision as a new file next to the original.

You can limit it to the current clip, include notes marked done, or leave out the technical numbers.

> If you use Claude Code (or Claude with file access), it can open the stills, because the prompt gives their full paths.

### 5. Export

**Export → AAF for Pro Tools…** creates a new folder in the project's **Exports** folder with:

| File | What it is |
|---|---|
| `name.aaf` | The audio of your edit with the media **embedded**: 48 kHz, 24-bit, one mono track per channel (L / R), with the **full source audio** so your engineer can extend any clip. Volume changes come through as clip gain, and the sequence starts at the timecode you choose (01:00:00:00 by default). |
| `name cue sheet.txt` | Every clip with its timecode, source range and gain, plus anything AAF can't carry (fades, muted parts, speed changes). |
| `name reference.mp4` | Your edit as video with burned-in timecode (needs ffmpeg). |

In Pro Tools: **File → Import → Session Data…**, choose the `.aaf`, and pick the tracks. Import the reference video with **File → Import → Video…**.

Why AAF and not OMF? AAF is OMF's modern replacement, and it's what Pro Tools, Media Composer and Premiere use today. OMF files can't be larger than 2 GB. Pro Tools imports both the same way, so if your engineer asks for OMF, an AAF works in its place.

**Export → MP4 of my edit** renders what you see in the player (needs ffmpeg).

---

## Your files are safe

- The app **never deletes, moves or overwrites** anything. There is no delete call in its code, and `test/safety.test.js` checks that.
- Files you add are **copied** into the project. If a name is taken, the copy becomes `name (2).mp4`.
- Every export goes into its **own new folder**. ffmpeg runs with `-n`, which makes it refuse to overwrite.
- The app only writes in two places inside a project:
  - `.review/` (a hidden folder): notes and edits (`review.json`), earlier versions of them (`history/`), stills (`frames/`), thumbnails and waveforms (`cache/`), playable copies (`proxies/`).
  - `Exports/`: your AAF and MP4 exports.
- The server only listens on your own computer (`127.0.0.1`) and refuses requests from other websites.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | One frame back / forward (hold `⇧` for one second) |
| `C` | Add a note at the playhead |
| `S` | Split at the playhead |
| `T` / `A` | Add text / audio |
| `Delete` | Remove the selected piece |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `+` / `-` | Zoom the timeline (or `⌘`/`Ctrl` + scroll) |
| `Esc` | Cancel the note / clear the selection |

---

## Good to know

- **Playback** uses your browser, so what plays depends on the browser. MP4 (H.264) plays everywhere. Safari on a Mac also plays ProRes and HEVC. For anything else, the app offers to make a playable copy (needs ffmpeg). Exports always use your original file.
- **AAF** files are checked by three independent readers in the tests: pyaaf2 (a mature AAF library), olefile, and the app's own reader. The layout copies what Pro Tools itself writes when it exports an AAF with embedded audio. These files haven't been opened in Pro Tools itself yet, so try a small project before a real deadline.
- **Fades** aren't stored in the AAF. They're listed in the cue sheet. Muted pieces are left out of the AAF.
- **Without ffmpeg**, AAF audio is decoded by the browser, which is fine for normal-length videos (files up to about 1 GB). Sped-up parts are then resampled, so their pitch follows the speed.
- **Text** in renders uses Arial (or DejaVu Sans on Linux), so it looks like the preview but may not match it pixel for pixel.

## For developers

```
server.js                 HTTP server (Node built-ins only)
lib/safe-fs.js            every file write; no deletes, no overwrites
lib/projects.js           projects = folders; notes in .review/review.json
lib/aaf.js                AAF writer (compound file + AAF objects)
lib/aaf-template.json     fixed AAF schema, made by tools/make-aaf-template.py
lib/render.js             edit → ffmpeg filter graph
lib/exporter.js           AAF / MP4 export jobs, cue sheet
public/js/timeline.js     edit model shared by browser and server
public/js/prompt.js       the "Copy moments" prompt
public/js/project.js      player, timeline editor, notes
```

```bash
npm test     # unit, safety, server and AAF tests; browser tests run if Playwright is installed
```

`VR_BIG_TEST=1 npm test` also writes a ~465 MB AAF to check very long exports.

The browser tests also need ffmpeg (to make test videos) and Playwright (`npm i -D playwright`). Without them, those tests skip themselves.
