# dsh-webdav-enhanced

[![npm version](https://img.shields.io/npm/v/dsh-webdav-enhanced?color=4a7dff)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![npm downloads](https://img.shields.io/npm/dm/dsh-webdav-enhanced)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![GitHub stars](https://img.shields.io/github/stars/HUIdada1/dsh-webdav-enhanced?style=social)](https://github.com/HUIdada1/dsh-webdav-enhanced)
[![license](https://img.shields.io/npm/l/dsh-webdav-enhanced)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-webdav-enhanced)](./package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4a7dff)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[简体中文](README.md) | **English**

Sync plugins, skills and model configs of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`) across all your machines through any WebDAV server.

Install once on one machine — the rest follow automatically. No more repeated installs, manual `settings.yaml` copying, or late-night environment matching.

## Features

| Capability | Details |
| --- | --- |
| **Plugin sync** | Bundles from your profile are packed and uploaded; other machines download and install them automatically |
| **Skill sync** | Skill folders under `$DSH_HOME/skills` are synced as a whole — write once, use everywhere |
| **Model config sync** | Top-level keys of `settings.yaml`, opt-in and off by default |
| **Two-way or one-way** | Each machine independently picks two-way, upload-only, or download-only |
| **Automatic dedup** | SHA-256 content addressing — the same zip is stored once, no matter how many machines upload it |
| **No silent data loss** | Soft locks, conflict copies and local backups keep every old version recoverable |
| **Scheduled sync** | Every N hours, with 0–5 minutes of jitter to avoid lock contention |
| **Auto-install** | Newly downloaded plugins and skills are written to disk and registered |

## Install

Search for `dsh-webdav-enhanced` in the dsh **Add plugin** wizard, or use the CLI:

```bash
# Desktop app (Electron) — profile is `desktop`
dsh plugin --profile desktop add dsh-webdav-enhanced

# Web GUI — profile is `web`
dsh plugin --profile web add dsh-webdav-enhanced
```

From a local checkout (link install — rebuild, restart, done):

```bash
dsh plugin --profile desktop add link:/path/to/dsh-webdav-enhanced
```

Restart dsh, then open **Plugins** in the left sidebar → scroll to **Installed plugins** → click **dsh-webdav-enhanced**. The configuration panel renders inside the plugin's detail page.

> The config page mounts on the `plugins.bundle.config` slot, so it lives in the **plugin detail page**, not as a standalone Settings entry.

## Quick start

1. **Connection**: enter your WebDAV URL, username and password, then click **Test Connection**. The test walks through PROPFIND, MKCOL, PUT and read-back, and probes whether the server supports LOCK / If-Match.
2. **Sync Content**: choose what to sync. Plugins and skills are on by default; model config is off.
3. **Sync Mode**: pick a direction and an interval (e.g. every 1 hour). Two-way is the default.

Click **Save** on each tab. A successful connection test triggers the first sync.

## Settings tabs

| Tab | Contents |
| --- | --- |
| Connection | URL, username, password, timeout, remote root, ignore self-signed TLS |
| Sync Content | Toggles for plugins / skills / config, exclude lists, whitelisted keys |
| Sync Mode | Direction, interval, conflict policy |
| History & Diagnostics | Last run, environment probe, current lock holder, recent logs |
| Danger Zone | Reset local sync state, clear remote data (requires typing `DELETE`) |

## Configuration

Most settings live in the UI; the rest is set through the profile's `cordis.patch.yml`:

| Field | Default | Notes |
| --- | --- | --- |
| `profile` | `desktop` | Which dsh profile to sync. `desktop` for the app, `web` for the Web GUI |
| `connection.url` / `connection.username` | empty | Also editable in the UI |
| `connection.password` | empty | First-run migration source only; the local credential file wins afterwards |
| `schedule.enabled` / `schedule.intervalHours` | `false` / `1` | Scheduled sync |
| `conflictPolicy` | `merge-backup` | Conflict policy |
| `scope.*` | plugins + skills `all`, config `none` | What to sync |

## What gets synced

- **Plugins**: profile `package.json` dependencies marked with `dsh.bundle`, packed from their local paths.
- **Skills**: every folder under `$DSH_HOME/skills` that contains a `SKILL.md`, including all files inside.
- **Config**: top-level keys of `settings.yaml`, narrowed with `includeKeys` when needed. `.credentials.yaml` never participates.

## Conflict policies

| Policy | Behaviour |
| --- | --- |
| **Auto-merge + local backup** (default) | Downloads the remote version and packs your local version into `$DSH_HOME/.webdav-enhanced/backups/<kind>s/` |
| **Ask on conflict** | Same as above, but the UI flags conflicting entries prominently |
| **Local wins** | Uploads your version and overwrites the remote one |
| **Remote wins** | Downloads the remote version and overwrites local (old local copy is still backed up) |

## Server compatibility

| Server | Notes |
| --- | --- |
| **Nextcloud / ownCloud** | Fully supported; use an app password instead of your login password |
| **Jianguoyun (坚果云)** | Works after enabling WebDAV in account settings; use the app password and keep the interval ≥ 1 hour due to rate limits |
| **Synology** | Fully supported with the WebDAV Server package |
| **AList** | Fully supported with any storage driver |
| **Self-hosted** | Any RFC 4918 implementation; without LOCK / If-Match it degrades to soft locks and conflict copies |

## Security

- **API keys are never synced by default**: `.credentials.yaml` and `apiKey` fields in `settings.yaml` are excluded, and config sync is off unless you enable it.
- **Credentials stay local**: the WebDAV password is written to `$DSH_HOME/.webdav-enhanced/credentials.json` (mode 0600). It never enters the cordis config, never reaches the server, and never appears in any API response.
- **Integrity checks**: every zip is content-addressed by SHA-256 and verified on download.
- **Extraction guards**: path traversal and zip bombs are rejected; 128MB per file, 512MB total.

## Remote layout

```
/dsh-sync/
├── manifest.json        # Global ledger: entries, hashes, source machines
├── locks/sync.lock      # Soft lock (native LOCK when supported)
├── bundles/*.zip        # Content-addressed plugin packages
├── skills/*.zip         # Content-addressed skill packages
├── configs/*.zip        # settings.yaml fragments (opt-in)
└── trash/               # Soft-deleted content, recoverable
```

## Local layout

```
$DSH_HOME/.webdav-enhanced/
├── webdav-enhanced.json     # Sync config and state (no password)
└── credentials.json     # WebDAV password (0600, never committed, never uploaded)
```

## Agent tools

The plugin registers two tools you can call straight from a conversation:

| Tool | Purpose |
| --- | --- |
| `webdav_sync_status` | Last sync time, machine ID, environment probe, schedule |
| `webdav_sync_now` | Run a sync immediately and return the report |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| HTTP 401 on test | Wrong credentials | Nextcloud and Jianguoyun need an app password |
| HTTP 405 on MKCOL | Directory already exists | Harmless, sync continues |
| HTTP 412 during sync | Remote changed mid-merge | Automatic retry (3 attempts); persistent failures mean another machine is syncing |
| Sync is slow | Large files in a synced folder | `node_modules` is excluded automatically; add others to the exclude list |
| Skills missing after sync | dsh cached the skill index | Start a new chat or restart dsh web |
| Plugin not active after install | dsh loads plugins at startup | Click **Restart** in the banner, or restart manually |

## Development

```bash
npm install
npm run check   # typecheck + tests + build
```

`npm run build` runs `tsc` to emit `lib/*.js`, then copies `src/client.js` to `lib/client.js`. The client is plain JS with no imports, so it needs no bundler — dsh loads it through `exports["./client"]` in the `window.__ModuleLoader__.load({ id, factory })` format.

Tests use a bundled mock WebDAV server (`tests/mock-webdav-server.ts`), so the full sync flow runs offline.

## License

[MIT](./LICENSE)
