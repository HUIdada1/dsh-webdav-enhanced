# WebDAV sync

Keep plugins, skills and model config aligned across machines through one WebDAV server: configure one machine, the rest follow.

## How to use it

The settings live right below, under **Connection**:

1. Enter the WebDAV URL, username and password, then **Test connection**. The test checks PROPFIND, MKCOL, PUT and read-back, and probes whether the server supports LOCK / If-Match.
2. Open **Content** and pick what to sync. Plugins and skills are on by default; model config is off (so API keys stay local).
3. Open **Mode** to choose direction and interval. Two-way, no schedule, by default.
4. **Sync now** in the header runs a sync whenever you want and reports uploads, downloads and errors.

## Three things worth knowing

- **The password never leaves this machine.** It is stored in `$DSH_HOME/.webdav-enhanced/credentials.json` (mode 0600) and is never part of the cordis config, the remote data, or any API response.
- **Config sync is opt-in.** `settings.yaml` can hold API keys, so enable it deliberately or narrow it with "only these top-level keys".
- **Conflicts never lose data.** The default policy downloads the remote version and packs the previous local one into `$DSH_HOME/.webdav-enhanced/backups/`.

## Supported servers

Nextcloud / ownCloud, Nutstore (app password), Synology WebDAV Server, AList, and any RFC 4918 implementation. Without LOCK / If-Match it degrades to a soft lock plus conflict copies.

See `README.md` in the package for the full reference: remote layout, conflict policies, config fields and FAQ.
