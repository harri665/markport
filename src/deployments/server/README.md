# Markport - server deployment (Docker Compose)

Runs the Node server (`src/runtime-server/server`) in a container, with vaults
stored as ordinary folders of `.md` files on a Docker volume. Every browser that
opens the site sees the same vaults.

The app has **no login of its own**. Anyone who can reach it can read and change
every vault. Compose therefore publishes it on `127.0.0.1` only, and HTTPS and
authentication belong in a reverse proxy in front of it.

## Requirements

- Docker Engine with the Compose plugin.
- Outbound HTTPS from the build host to `github.com`/`api.github.com`. The image
  build downloads Obsidian's Android APK from Obsidian's own GitHub releases and
  extracts the renderer from it.
- A reverse proxy that can do HTTPS, authentication and WebSockets.

## Run

From the repo root:

```bash
cp .env.example .env        # optional; every value has a default
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

The start screen's **Create new vault** button creates a vault **in that
browser's own storage**, not on the server. Those notes stay in that one browser.
Use a folder on the server for anything you want everywhere.

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

## Reverse proxy

Whatever you use, it must:

1. **Require authentication** on every path, including `/api/*` and the
   WebSocket.
2. **Pass WebSocket upgrades** for `/api/watch`. Without them the app still
   works, but changes made outside it (another device, a file sync) only show up
   after a reload.
3. **Allow large request bodies.** Attachments are uploaded as one `PUT` of up
   to 256 MB. nginx's default limit is 1 MB.

### Caddy

```caddy
notes.example.com {
	basic_auth {
		# caddy hash-password --plaintext 'your-password'
		alice $2a$14$REPLACE_WITH_HASH
	}
	reverse_proxy 127.0.0.1:3500
}
```

Caddy handles HTTPS, WebSockets and large bodies by default.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;
    # ssl_certificate / ssl_certificate_key ...

    auth_basic           "Markport";
    auth_basic_user_file /etc/nginx/markport.htpasswd;   # htpasswd -c ... alice

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

In `compose.yaml`, remove the `ports:` block, uncomment the `networks:` lines and
set the external network name to your proxy's. Then route to
`http://markport:3500`. Enable the proxy's own auth (Traefik `basicauth`
middleware, an NPM access list, Authelia/Authentik, ...).

### Cloudflare Tunnel

Point the tunnel at `http://127.0.0.1:3500` (or `http://markport:3500` on a
shared network) and protect the hostname with a Cloudflare Access policy.
WebSockets work through tunnels without extra settings.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MARKPORT_BIND` | `127.0.0.1` | host interface to publish on |
| `MARKPORT_PORT` | `3500` | host port |
| `MARKPORT_DATA` | `markport-data` | named volume, or a host path |
| `DEFAULT_VAULT_NAME` | `Notes` | vault created when there is none |
| `WATCH_POLLING` | `false` | `true` for network filesystems |
| `OBSIDIAN_VERSION` | `1.12.7` | Obsidian release to bundle; 1.13+ does not boot |

The image also sets the server's own variables (`HOST`, `PORT`, `VAULTS_DIR`,
`VAULT_PATH`, `VAULT_REGISTRY`). See "Configuration" in the root `README.md`.
