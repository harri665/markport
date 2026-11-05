# Markport Clipper

Collect images from the web into your vault, Eagle-style: drag an image onto a folder, click one, or screenshot part of any
page, and each one lands in the folder you chose. It works with a vault open in **desktop
Obsidian** or in **Markport**.

Two parts:

| Part | Where | What it does |
|---|---|---|
| Browser extension (Chrome, Edge, Brave...) | `src/browser-extension/` (this folder) | Capture mode, drag-and-drop folder menu, right-click menu, fetching the image |
| Obsidian plugin "Markport - Image Clipper" | `src/plugins/markport-clipper/` | Writes the image into the vault, keeps the target folder |

## Install

### 1. The extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and pick this folder, `src/browser-extension/`.
3. Optional: pin it to the toolbar.

### 2. The plugin

**Markport:** nothing to do. It is a system plugin, so every vault opened in Markport has it.
(Restart the server once after pulling it, since system plugins are discovered at startup.)

**Desktop Obsidian:** copy the plugin into the vault, then turn it on.

```powershell
# PowerShell; <vault> is the vault's folder
$dst = "<vault>\.obsidian\plugins\markport-clipper"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item src\plugins\markport-clipper\manifest.json, src\plugins\markport-clipper\main.js, src\plugins\markport-clipper\styles.css $dst
```

```bash
# bash
mkdir -p "<vault>/.obsidian/plugins/markport-clipper"
cp src/plugins/markport-clipper/{manifest.json,main.js,styles.css} "<vault>/.obsidian/plugins/markport-clipper/"
```

In Obsidian: **Settings > Community plugins**, turn community plugins on if needed, and enable
**Markport - Image Clipper**. Then pair it with the extension:

1. In Obsidian, **Settings > Markport - Image Clipper > Pairing key > Copy**.
2. Right-click the extension's icon > **Options**, paste the key under *Obsidian (desktop app)*, **Save**.
3. **Find vaults** should list the vault as "*name* (Obsidian)".

Each vault has its own key. Paste one per line to use several vaults.

## Use

- **Capture mode:** click the extension's icon, or press **Alt+Shift+S**. The page dims.
  - **Drag** a rectangle to take a screenshot of that part of the page. The folder menu opens
    at the pointer. Pick a folder and it is saved as `Screenshot <date> at <time>.png`.
  - **Click an image** (it gets outlined as you point at it) to save that image through the
    same menu. Clicking saves it instead of following any link around it.
  - The **gear** at the top middle sets the default folder, turns the drag menu on or off, and
    opens Options.
  - **Esc**, or the **×** at the top right, cancels. Clicking outside the menu dismisses it so
    you can draw again. Capture mode ends after one save.
- **Drag an image** on any page and the folder menu opens beside the pointer. Drop the image on
  a folder to save it there. The menu is a small grid of at most six folders: the folder you last
  saved an image to is at the top left, then your other recent folders and the default folder.
  Below it, the **Vault root** bar reaches every other folder: rest the image on it and a menu of
  the vault's folders opens beside the popup; rest on a folder there and the next menu shows its
  subfolders, and so on. Drop on any of them. (Without a drag, hover and click the same way.)
  Hold the image over another vault's name to open that vault. Drop on **New Folder…** to type
  a name first. Dropping anywhere else works as usual, and nothing is saved. You can turn
  the menu off with the gear or in Options. It never shows inside Markport or Obsidian, where
  dragging moves files. After installing or updating the extension, reload the pages you want
  to drag from.
- **The menu** is frosted glass and follows the system's light or dark mode.
- **Right-click an image > Save image to Markport / Obsidian** saves it without capture mode, into
  the vault and folder you used last.
- **In Obsidian**, right-click a folder > **Save clipped images here**, or run **Choose clip
  folder**. The status bar shows the current folder (desktop layout).
- **The image library** (ribbon icon, or the command **Open image library**) browses every
  image in the vault, next to a **board** for composing them. Left to right:
  - The **sidebar** has All images, Untagged, the folders that hold images, smart folders
    (Added this week, plus any search you save with the bookmark button by the search box) and
    your tags. It collapses into a rail of colored initial chips.
  - The **grid** is masonry, with search (`#tag` or `tag:x` filters by tag, `color:teal` or
    `color:#3e6f72` by color) and sorting and thumbnail size under the sort button. Click,
    Ctrl/Cmd-click or Shift-click to select. **F** (or Space) opens a full-screen viewer that
    steps with ← →. **I** opens Details. Double-click or Enter opens an image, and Delete moves
    the selection to the trash. Drag images onto the board to place them, onto a sidebar folder
    to move them, or into a note to embed them. Drop files from your computer onto the grid or a
    folder to import them.
  - The **board** is a `.canvas` file (new ones go in the `Boards` folder, set in the plugin's
    settings), so it also opens in Obsidian's Canvas. Place and resize images, draw (D), add
    sticky notes (N, or double-click), and group (G). Drag empty space to pan, and use
    Ctrl/Cmd + wheel or a pinch to zoom. Boards open as tabs in the library's top bar. Pen
    strokes are stored in an extra `markport` field that Obsidian's Canvas does not know about,
    and may drop if you edit the board there.
  - **Pin over app…** opens the board in a small window that stays above other apps (Document
    Picture-in-Picture, Chrome/Edge), with a library strip to drag images from. Desktop Obsidian
    opens a popout window instead, and other browsers a floating panel.

  The grid and the board each have **Fill window** and **Minimize**; the window is never left
  empty. **Details** floats over the layout: the selected image's colors, size and dates, the
  page it was clipped from, the boards it is used on, and a color picker. It also lets you rename
  the image and edit its tags and note. Tags, notes and colors are kept in the plugin's
  `data.json`, not in the images, and follow the files when they are moved or renamed. It works
  the same in desktop Obsidian and in Markport.

Screenshots use the browser's capture of the visible tab, so only what is on screen can be
captured, and the browser's own pages (see Limits) can't be.

Clicking or dragging finds `<img>` (the largest `srcset` candidate), CSS background images, inline `<svg>`,
`<canvas>` and video posters, including images under transparent overlays. Anything smaller than
24 px is ignored as an icon.

File names come from the image URL, then its alt text, then the page title. The extension comes
from the actual bytes, so a `.jpg` URL that serves WebP is saved as `.webp`. Existing files are
never overwritten: `cat.png` becomes `cat 1.png`. Turn on **Create a note for each image** to
also write a note that embeds the image and records the page it came from.

## How it connects

- **Markport:** the extension looks for tabs on the Markport addresses in its Options (default
  `http://127.0.0.1:3500` and `http://localhost:3500`). It calls the plugin's
  `window.__markportClipper` inside that tab with `chrome.scripting.executeScript`. The vault
  must be open in a tab, not just the start screen. Add your own address (for example the one
  behind your reverse proxy) in Options.
- **Desktop Obsidian:** desktop Obsidian has no tab to call into, so the plugin listens on
  `127.0.0.1`. It uses the first free port from 27150 to 27159, one per open vault. `GET /ping`
  is open. `GET /info`, `POST /target` and `POST /save` need the pairing key as
  `Authorization: Bearer <key>`. The plugin also refuses requests with a web page's `Origin`, a
  `Host` other than loopback (DNS rebinding), or a body that isn't `application/json`. It sends
  no CORS headers. So a web page cannot write into your vault, even though the server is on
  your machine. **New key** in the plugin's settings revokes the old one.

The extension fetches images itself, with your cookies, so images behind a login work. If that
fails, it retries inside the page, which covers `blob:` URLs and referer-checked images. The
image size limit is 50 MB.

## When no vault is found

**Options > Find vaults** lists every place the extension checked, and why each one didn't work.
Common causes:

- **Sleeping tabs**: Edge's sleeping tabs and Chrome's Memory Saver freeze or discard
  background tabs, and a sleeping tab can't run the extension's script. The extension wakes it
  by reloading it in the background, without switching to it. That takes a second or two, and
  Find vaults then says "the tab was asleep; reloaded it to wake it". Nothing is lost:
  Obsidian has already saved the vault. It also asks the browser not to discard the tab again.
  If you see **"The tab is asleep ... did not wake up"**, switch to the tab once. To stop the
  browser from putting it to sleep: in Edge, Settings > System and performance > *Never put
  these sites to sleep* > add your Markport address; in Chrome, Settings > Performance >
  *Always keep these sites active*.
- **"No vault open in this tab"**: the tab shows Markport's start screen. Open a vault.
- **"No tab open at ..."**: Markport is open at an address that isn't in Options, for example
  behind a reverse proxy. Add that address.
- **"The Markport Clipper plugin is not loaded"**: in Markport, restart the server after pulling
  the plugin. In Obsidian, enable the plugin.
- **"no pairing key" / "None of the saved pairing keys"**: copy the key from the plugin's
  settings in that vault into Options.

After changing the extension's files, reload it on `edge://extensions` (or `chrome://extensions`).

## Limits

- The Obsidian mobile apps can't be reached. The plugin loads there but does nothing for the
  extension.
- Pages the browser keeps extensions out of (`chrome://`, the Web Store, the PDF viewer) can't
  be clipped.
- `<canvas>` elements that drew cross-origin images are locked by the browser and can't be saved.
- Firefox is untested. The extension uses Manifest V3 `scripting` and a service worker.

## Tests

Both run with `npm test`:

- `src/client-mobile/test/markport-clipper.test.js` covers file naming, saving into a fake
  vault, the desktop server's checks (with a real HTTP server on loopback), and the extension's
  helpers.
- `src/client-mobile/test/markport-clipper-background.test.js` runs `background.js` against a
  fake `chrome` API. It covers waking sleeping tabs, the Find vaults checks, saving into a
  dropped-on folder, and desktop pairing.
