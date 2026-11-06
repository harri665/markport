# Markport Sync

An Obsidian plugin for the **native app** (desktop or mobile) that makes it one more session on a
Markport server. Link any or all of the server's vaults, each into a folder of your local vault
(or one of them into the whole vault), and edits flow both ways live:

- What you change in the app shows up in every open Markport tab within about a second.
- What anyone changes in Markport, or on another device, shows up in the app the same way.

It uses the same `/api/fs` and `/api/watch` WebSocket as the web client, so the server can't
tell it from a browser tab.

This is not one of Markport's system plugins in `src/plugins/`, which every vault opened in
Markport gets automatically. Markport doesn't need it; only the native app does.

## Install

From a clone of this repo, on a desktop: `<vault>` is the vault's folder, or its name as
Obsidian shows it.

```bash
npm run clipper -- --add <vault> --plugin markport-sync
```

That copies the two files below into the vault, turns the plugin on, and keeps it up to date
whenever you run `npm run clipper` again after a `git pull`. Restart Obsidian afterwards. Or
copy the two files by hand:

```powershell
# PowerShell; <vault> is the local vault's folder
$dst = "<vault>\.obsidian\plugins\markport-sync"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item src\native-plugins\markport-sync\manifest.json, src\native-plugins\markport-sync\main.js $dst
```

```bash
# bash
mkdir -p "<vault>/.obsidian/plugins/markport-sync"
cp src/native-plugins/markport-sync/{manifest.json,main.js} "<vault>/.obsidian/plugins/markport-sync/"
```

On a phone, copy the same two files into `<vault>/.obsidian/plugins/markport-sync/` with any
file manager or sync tool, then restart Obsidian.

In Obsidian: **Settings > Community plugins**, turn community plugins on if needed, and enable
**Markport Sync**.

## Set up

In **Settings > Markport Sync**:

1. **Server URL**: the address you open Markport at, e.g. `https://notes.example.com`.
2. **Sign in** with the server's `MARKPORT_PASSWORD`. The password is exchanged once for a
   token, valid for a year, and is not stored. Changing the server's password signs every
   device out. If the server has no password, just press **Sign in**.
3. **Server vaults** lists every vault on the server. For each one you want, check the folder
   next to it and turn it on. **Link all** links every vault, each into a folder named after it.
   Leave the folder empty to sync a vault into the whole local vault (it must then be the only
   one linked).

Files already in a folder when you link it are merged with the server's, never deleted. The
status bar shows `Markport: synced`, `syncing N` or `offline`; click it for the settings.

Commands: **Sync now** (compare everything right away) and **Reconnect to the server**.

## Sharing

Right-click a note or folder inside a linked folder and choose **Share on Markport…** (or run
**Share current note on Markport**). It's the same dialog as **Share…** in the Markport web app:
pick **View only** or **Can edit**, optionally a password, an expiry date and a **custom link**
(`/s/project-alpha` instead of a random id), and **Create link and copy**. The pencil button on a
link changes or removes its custom name. The link opens on your server (`<server URL>/s/<id>`) and reaches only that note or
folder. **Manage shared links on Markport** lists the links for every linked vault, with copy,
open and revoke.

The link points at the server's copy, so a note you only just created has to finish syncing
(`Markport: synced`) before it can be shared. Hidden files and folders can't be shared, and
items outside the linked folders don't get the menu entry. Links are made with the plugin's
token, so you have to be signed in. Share pages use the server vault's theme, not this app's,
unless **Sync settings and plugins** is on.

## How it behaves

| Situation | What happens |
|---|---|
| Changed on one side | copied to the other |
| Changed on both sides, `.md`/`.txt`, edits on different lines | merged, on both sides |
| Changed on both sides, otherwise | the server's version stays; yours is saved next to it as `name (conflict <device> <date>).md`, on both sides |
| Deleted on one side, unchanged on the other | deleted there too: on the server into the vault's `.trash/` folder, here into the trash you chose in Obsidian |
| Deleted on one side, changed on the other | the changed file is restored to the side that deleted it |
| Renamed or moved in the app | renamed on the server |
| Offline | changes are compared on reconnect; a full comparison also runs every few minutes (setting) |
| A full comparison would delete more than 10 files (and more than a quarter of the vault) | you are asked first; **Keep them** copies them back instead |

Hidden files and folders (`.obsidian`, `.trash`, dotfiles) are not synced as notes, so each side
keeps its own settings, plugins and themes, unless you turn on **Sync settings and plugins**.

## Settings and plugins

**Sync settings and plugins** (in the plugin's settings) also keeps this vault's `.obsidian` in
step with the server vault: Obsidian's settings, hotkeys, appearance, themes, CSS snippets, and
the community plugins with their settings. It works for the server vault synced into this whole
vault (folder left empty), so turn it on once that link exists. Turn it on on every device that
should share the setup.

- It is compared on every full comparison (on start, on reconnect, every few minutes) and a few
  seconds after a setting changes here, not live like notes: the server doesn't report changes
  to hidden folders.
- The first time, **this device's copy wins** wherever the two differ, and the server's copy
  goes into the server vault's `.trash/.obsidian/`. Turn it on first on the device whose setup
  you want everywhere.
- After that, a file changed on both sides keeps the newer copy; the other one goes into that
  side's trash (`.trash/` in the vault).
- Not synced: `workspace.json` and `workspace-mobile.json` (each device's open tabs and
  panes), Markport Sync's own folder (its server, sign-in and links belong to each device), and
  the code of Markport's own plugins (Markport Clipper, Markport Share, the layout switcher),
  which every Markport server serves itself. Their `data.json` is synced, so the clipper's image
  library follows you.
- Which plugins are on (`community-plugins.json`) is synced, except Markport's own plugins: the
  server always has those on, so each device keeps its own choice for them.
- Obsidian reads most of these files when it starts. When settings or plugins arrive from the
  server, a notice says so: click it to reload Obsidian.

The server vault's `.obsidian` is also what Markport's web app uses for that vault, so a plugin
turned on here is turned on there too. One that needs the desktop app may not work in the
browser (for Claudian, see `MARKPORT_NODE_BRIDGE` in `src/deployments/server/README.md`).

Merges use the last synced text, which is kept in memory. Right after Obsidian starts, a file
changed on both sides gets a conflict copy instead of a merge.

## Server and proxy

Needs a Markport server with this release or later (`/api/fs/tree`, `/api/auth/token`). The
plugin sends its token as an `X-Markport-Token` header, and on the WebSocket as the subprotocol
`markport-token.<token>`. A reverse proxy has to pass both through, and pass WebSocket upgrades
for `/api/watch` (see `src/deployments/server/README.md`). If the proxy does its own
authentication (basic auth, Authelia, Cloudflare Access), the plugin can't get past it. Use
`MARKPORT_PASSWORD` instead, or exempt `/api/` for the plugin.

## Limits

- File names that differ only in case (`Note.md` and `note.md`) are two files on a Linux server
  but one on Windows and macOS. Rename one on the server.
- A file and a folder with the same path on different sides are left alone and logged in the
  developer console.
- Large vaults: the first sync downloads every file, four at a time.
