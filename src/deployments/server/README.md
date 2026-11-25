# Markport - server deployment (Docker Compose)

Runs the Node server (`src/runtime-server/server`) in a container, with vaults
stored as ordinary folders of `.md` files on a Docker volume. Every browser that
opens the site sees the same vaults.

Set **`MARKPORT_PASSWORD`** to give the app its own login. Every vault and API then needs
that password, and [share links](#sharing) are the only way in without it. Without a password
there is no login, and anyone who can reach the app can read and change every vault. Compose
publishes it on `127.0.0.1` only either way, and HTTPS belongs in a reverse proxy in front of it.

## Requirements

- Docker Engine with the Compose plugin.
- Outbound HTTPS from the build host to `github.com`/`api.github.com`. The image
  build downloads Obsidian's Android APK from Obsidian's own GitHub releases and
  extracts the renderer from it.
- A reverse proxy that can do HTTPS and WebSockets (and authentication, if you don't set
  `MARKPORT_PASSWORD`).

## Run

From the repo root:

```bash
cp .env.example .env        # then set MARKPORT_PASSWORD in it
docker compose up -d --build
docker compose logs -f      # "[vaults] 1 vault(s) in /data/vaults" then "Listening on ..."
```

The app is now on `http://127.0.0.1:3500` on the server. Point your proxy at it.
On first start a vault named `Notes` (from `DEFAULT_VAULT_NAME`) is created and
shown on the start screen.

**Update** after pulling new code: `docker compose up -d --build`. Vaults are on
the volume and survive rebuilds.

The image contains Obsidian's proprietary bundle, so build it where you run it
and don't push it to a public registry. See "Disclaimer" in the root `README.md`.

## Vaults

| Path in container | Contents |
|---|---|
| `/data/vaults/<name>/` | one folder per vault |
| `/data/registry.json` | vault ids (keeps `/vault/<id>` links stable) |

Each top-level folder of `/data/vaults` is registered as a vault at startup.
**To add a vault, create a folder and restart**:

```bash
docker compose exec markport mkdir /data/vaults/Work
docker compose restart
```

Deleting a folder removes the vault from the list at the next start. Folders
starting with `.` are ignored.

The start screen's **Create new vault** offers three storage options:

| Option | Where the notes live |
|---|---|
| **On the server** (default) | a new folder in `/data/vaults`, seen by every browser |
| **Folder on this computer** | a local folder you pick (Chrome/Edge only) |
| **Browser storage** | inside that one browser; clearing site data deletes it |

"On the server" creates the folder straight away, no restart needed.

### Using a host directory instead of a volume

To see and back up the files directly on the host, set `MARKPORT_DATA` in `.env`
to a path. The container runs as uid 1000, so that path must be writable by it:

```bash
sudo mkdir -p /srv/markport && sudo chown -R 1000:1000 /srv/markport
echo 'MARKPORT_DATA=/srv/markport' >> .env
docker compose up -d
```

You can drop an existing Obsidian vault into `/srv/markport/vaults/` and restart.
If that directory lives on NFS/SMB/rclone, also set `WATCH_POLLING=true`.

### Backups

The vaults are plain files. Back up the volume or the host directory, for example:

```bash
docker run --rm -v obsidian-web2_markport-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/markport-$(date +%F).tar.gz -C /data .
```

The volume name is `<project>_markport-data`. `docker volume ls` shows it.
`/data/media-cache` needs no backup: it only holds thumbnails and optimized
copies, which the server makes again when they are missing.

## Reverse proxy

Whatever you use, it must:

1. **Authenticate**, one of two ways:
   - **`MARKPORT_PASSWORD` set (recommended)**: the proxy does *no* authentication of its
     own, only HTTPS. Markport checks every request itself, so share links work for people
     who have no account.
   - **No `MARKPORT_PASSWORD`**: the proxy must require authentication on every path,
     including `/api/*` and the WebSocket. Share links then only work for people who can get
     past the proxy.
2. **Pass WebSocket upgrades** for `/api/watch`. Without them the app still
   works, but changes made in another tab, on another device or outside the app
   only show up after a reload.
3. **Pass the `X-Markport-Token` header and the WebSocket subprotocol** if you use the
   native-app plugin (below). Proxies pass both unless told otherwise.
4. **Allow large request bodies.** Attachments are uploaded as one `PUT` of up
   to 256 MB. nginx's default limit is 1 MB.

### Caddy

```caddy
notes.example.com {
	reverse_proxy 127.0.0.1:3500
}
```

Caddy handles HTTPS, WebSockets and large bodies by default. Without `MARKPORT_PASSWORD`, add a
`basic_auth` block (`caddy hash-password` makes the hash).

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;
    # ssl_certificate / ssl_certificate_key ...

    # Only without MARKPORT_PASSWORD:
    # auth_basic           "Markport";
    # auth_basic_user_file /etc/nginx/markport.htpasswd;

    client_max_body_size 256m;

    location / {
        proxy_pass         http://127.0.0.1:3500;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 1d;   # keep the /api/watch socket open
    }
}
```

### Proxy in another container (Traefik, Nginx Proxy Manager, ...)

In `docker-compose.yml`, remove the `ports:` block, uncomment the `networks:` lines and
set the external network name to your proxy's. Then route to
`http://markport:3500`. Enable the proxy's own auth (Traefik `basicauth`
middleware, an NPM access list, Authelia/Authentik, ...).

### Cloudflare Tunnel

Point the tunnel at `http://127.0.0.1:3500` (or `http://markport:3500` on a
shared network). Set `MARKPORT_PASSWORD`, or protect the hostname with a Cloudflare
Access policy (share links then need an Access bypass rule for `/s/*` and the app's
files, so the password is simpler). WebSockets work through tunnels without extra settings.

## Connecting MCP clients

The server exposes an MCP endpoint at `/mcp`. Claude, ChatGPT and Gemini can use it to
read, search and change your vaults. Sign-in requires `MARKPORT_PASSWORD`.

### Claude

1. On claude.ai, open **Customize > Connectors**, then **+ Add > Add custom connector**.
2. Enter `https://<your host>/mcp` and keep the OAuth settings Claude detects.
3. Select **Connect**. On the Markport consent page, enter your Markport password and allow access.
4. Enable the connector in a chat with **+ > Connectors**.

For Claude Code: `claude mcp add --transport http markport https://<your host>/mcp`, then run
`/mcp` in Claude Code to sign in.

### ChatGPT

In ChatGPT on the web, open **Plugins**, choose **+ > Add custom MCP server**, and enter
`https://<your host>/mcp`. Choose OAuth, complete the Markport consent flow, then scan and
add the server. Custom MCP availability and write access depend on the ChatGPT plan and
workspace permissions.

### Gemini Apps

In the Gemini web app, open **Settings & help > Connected apps**, then add a custom app with
the URL `https://<your host>/mcp`. Follow the OAuth consent flow. Google currently requires
a personal Google Account, US availability and Gemini Apps Activity/history enabled for
custom apps.

### Gemini CLI

Gemini CLI can discover the OAuth configuration and register a client dynamically. Add
`https://<your host>/mcp` as a remote HTTP MCP server and run `/mcp auth <server-name>`.
Its OAuth callback uses localhost, which Markport allows automatically.

### Access and sign-in details

These clients can list vaults and files, read notes and images, search, write, edit, append,
create folders, move, copy and delete. Delete moves items to the vault's `.trash/`. Treat
connection approval as access to every Markport vault, and review tool actions before using them.

- The access token lasts one hour. Refresh tokens last 90 days and rotate; only the newest
  refresh token works.
- **Connected apps** are listed at `/oauth/connections`; disconnecting there revokes access
  immediately. Changing `MARKPORT_PASSWORD` signs every app out.
- Redirects are limited to `MARKPORT_OAUTH_REDIRECT_HOSTS` plus loopback. CIMD client
  metadata is fetched only from `MARKPORT_OAUTH_CLIENT_HOSTS`.
- Behind a proxy, Markport infers its public URL from `Host` and `X-Forwarded-Proto`.
  Set `MARKPORT_PUBLIC_URL` if OAuth discovery advertises the wrong address.
- The MCP endpoint, OAuth endpoints and `/.well-known/oauth-*` must be reachable by the
  connected client. If your proxy restricts visitors, allow the relevant service there.
- Additional instructions for MCP clients go in `/data/mcp-instructions.md`; edits apply
  without a restart.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MARKPORT_BIND` | `127.0.0.1` | host interface to publish on |
| `MARKPORT_PORT` | `3500` | host port |
| `MARKPORT_DATA` | `markport-data` | named volume, or a host path |
| `MARKPORT_PASSWORD` | *(empty)* | owner password for `/login`; empty = no login (proxy must authenticate) |
| `DEFAULT_VAULT_NAME` | `Notes` | vault created when there is none |
| `WATCH_POLLING` | `false` | `true` for network filesystems |
| `OBSIDIAN_VERSION` | `1.12.7` | Obsidian release to bundle; 1.13+ does not boot |
| `MARKPORT_NODE_BRIDGE` | *(on with a password)* | desktop-only plugins run their Node code in the container when you use the browser app. Unset: on when `MARKPORT_PASSWORD` is set, off without one. `false`: off. `true`: on regardless. See below |
| `INSTALL_CLAUDE_CODE` | *(follows the bridge)* | build the image with Claude Code, for Claudian; `false` leaves it out |
| `MARKPORT_MEDIA_CACHE_MB` | `5120` | size cap of the image library's cache (`/data/media-cache`): thumbnails, previews and web-optimized 3D models. Never inside a vault; safe to delete |
| `MARKPORT_MCP` | `true` | the MCP endpoint at `/mcp` (needs `MARKPORT_PASSWORD`). See [Connecting MCP clients](#connecting-mcp-clients) |
| `MARKPORT_PUBLIC_URL` | *(from each request)* | the address apps reach the server at, e.g. `https://notes.example.com` |
| `MARKPORT_OAUTH_REDIRECT_HOSTS` | `claude.ai,claude.com,chatgpt.com,oauth-redirect.googleusercontent.com,oauth-redirect-sandbox.googleusercontent.com,oauth-redirect-test.googleusercontent.com` | allowed OAuth callback hosts; loopback is always allowed |
| `MARKPORT_OAUTH_CLIENT_HOSTS` | `claude.ai,claude.com,anthropic.com,chatgpt.com,accountlinking.google.com` | hosts an app's OAuth client metadata document may come from |
| `MARKPORT_MCP_PLAIN_PUNCTUATION` | `false` | `true`: refuse writes through MCP that add em/en dashes or emoji to notes |
| `MARKPORT_MCP_INSTRUCTIONS_FILE` | `/data/mcp-instructions.md` | instructions sent to the app when it connects |
| `MARKPORT_MCP_DEFAULT_VAULT` | *(none)* | with several vaults: the one (name or id) the app uses when it names none. Without it every call has to name a vault |
| `MARKPORT_IMAGEMAGICK` | `true` | build the image with ImageMagick, for previews of HEIC, JPEG XL, JPEG 2000, EXR, HDR, DDS, XCF, BMP, ICO and more |
| `MARKPORT_FFMPEG` | `true` | build the image with ffmpeg, so Markport Sync can have large videos re-encoded as they are uploaded (its "Re-encode large videos" setting, off by default) |
| `MARKPORT_VIDEO_CRF` | `26` | quality of re-encoded videos: 18 (large files) to 32 (small) |
| `MARKPORT_VIDEO_PRESET` | `medium` | x264 preset for re-encoding; slower presets make smaller files |

The image also sets the server's own variables (`HOST`, `PORT`, `VAULTS_DIR`,
`VAULT_PATH`, `VAULT_REGISTRY`, `HOME=/data/home`). See "Configuration" in the
root `README.md`.

## Sharing

Right-click a note or folder in a vault and choose **Share link…**. Each link (`/s/<id>`) is a
read-only page rendered on the server with your theme. With **Can edit**, the page also offers
**Open in editor**, the Obsidian editor limited to that note, or to that folder and its
subfolders. Recipients don't need an account. Links can have a custom name (`/s/project-alpha`
instead of the random id, which keeps working; it's guessable, so add a password to anything
private), a password and an expiry date,
and you can revoke them from the same dialog or with **Manage shared links** (command palette).

What a link can reach is enforced by the server on every request: the shared item, plus
read-only access to images and files its notes embed (under **Linked files**, by file name
only). It can't reach other notes, vaults, your `.obsidian` settings or plugins, or any
owner API. Plugins are disabled in shares, and recipients get their own settings folder. When
an editor deletes a note, it goes to `/data/shares/<id>/trash/`, not into the vault and not to
nowhere. Links follow an item you rename or move inside Markport. If you move it outside
Markport, the link shows "no longer available".

Shares only exist for vaults on the server. Browser-storage and local-folder vaults live in one
browser and can't be shared.

| Path in container | Contents |
|---|---|
| `/data/shares.json` | the links (passwords stored as scrypt hashes) |
| `/data/shares/<id>/` | each link's settings folder and trash |
| `/data/session-secret` | signs login and share cookies; delete it to log everyone out |

## Several sessions at once

Any number of tabs, browsers and devices can have the same vault open. Every change made in one
(a save, a new file, a rename, a delete) is pushed over `/api/watch` to all the others as soon
as the server has it, without waiting for the file system to report it. Open notes update in
place. Changes made outside Markport (a shell, SMB, a sync tool) still arrive through the file
watcher, after a short delay, or every `WATCH_POLL_INTERVAL` with `WATCH_POLLING=true`.

### The native Obsidian app

The plugin **Markport Sync** (`src/native-plugins/markport-sync/`) links the desktop or mobile
Obsidian app to the server's vaults, any or all of them, each into a folder of a local vault.
It syncs both ways live, the same way a tab does. See its README for install and setup.

It signs in with the owner password once and gets an API token (`POST /api/auth/token`, valid
for a year). Changing `MARKPORT_PASSWORD` revokes every token, as it does every login. Files it
deletes on the server go to the vault's `.trash/` folder.

## Plugins and themes

Community plugins and themes install from **Settings → Community plugins / Appearance** as in
Obsidian. Downloads go through the server, so it needs outbound HTTPS to GitHub.

Two things differ from desktop Obsidian:

- **Markport runs Obsidian 1.12.7.** The plugin browser always installs a plugin's *latest*
  release. If that release needs a newer Obsidian, install an older one with the helper script:

  ```bash
  docker compose exec markport node /app/scripts/install-plugin.js /data/vaults/Notes <owner/repo> <version> --enable
  ```

  Then reload the vault. Community plugins have to be turned on once per browser
  (Settings → Community plugins), because Obsidian stores that setting in the browser.
- **Desktop-only plugins** (`isDesktopOnly`) expect Node.js: files on disk, child processes.
  Most of them only work with the node bridge.

### Node bridge (desktop-only plugins such as Claudian)

With the node bridge on, a plugin's `require('fs')`, `require('child_process')`,
`require('os')` and so on run **in the container**. A plugin acts as if Obsidian were installed
there: the vault is its folder under `/data/vaults`, and processes run as the container's `node`
user.

It only exists for the browser app. The native Obsidian app (desktop, with or without Markport
Sync) has Node of its own, runs these plugins itself and never talks to the bridge.

It is **on by default when `MARKPORT_PASSWORD` is set**: the bridge is one of the owner-only
`/api` routes, so only the signed-in owner can use it, and share links can't. Without a password
it is off by default. `MARKPORT_NODE_BRIDGE=false` turns it off; `=true` forces it on.

> **Forced on without a password, it lets anyone who can open the site run shell commands in the
> container**, and read or change everything on `/data`. Only do that with authentication in the
> reverse proxy. The bridge also refuses requests from other websites (cross-origin).

**Claudian** (Claude Code in a sidebar):

```bash
# .env
MARKPORT_PASSWORD=...               # the bridge is on with a password

docker compose up -d --build        # the image includes Claude Code
docker compose exec -it markport claude    # log in once; kept in /data/home
docker compose exec markport node /app/scripts/install-plugin.js /data/vaults/Notes YishenTu/claudian 2.1.4 --enable
```

Reload the vault and open Claudian from the ribbon. Claudian 2.1.4 is its last release that
supports Obsidian 1.12; newer ones need 1.13. Claude Code works in the vault's folder in the
container.

Not bridged: `fs.watch` (it never fires), and `http`/`https`/`net`/`tls`/`zlib` (they throw).
The bridge needs a Linux or macOS server; the Docker image is Linux.

### Latex Suite

Install 1.14.1, not 1.14.2. Version 1.14.2 doesn't load its default snippets at startup on any
Obsidian (it skips the load on its first run), so snippets do nothing until you change a setting:

```bash
docker compose exec markport node /app/scripts/install-plugin.js /data/vaults/Notes artisticat1/obsidian-latex-suite 1.14.1 --enable
```
