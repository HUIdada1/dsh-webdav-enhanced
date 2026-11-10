# dsh-webdav-enhanced

[![npm version](https://img.shields.io/npm/v/dsh-webdav-enhanced?color=4a7dff)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![npm downloads](https://img.shields.io/npm/dm/dsh-webdav-enhanced)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![GitHub stars](https://img.shields.io/github/stars/HUIdada1/dsh-webdav-enhanced?style=social)](https://github.com/HUIdada1/dsh-webdav-enhanced)
[![license](https://img.shields.io/npm/l/dsh-webdav-enhanced)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-webdav-enhanced)](./package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4a7dff)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[简体中文](README.md) | **English**

Sync plugins, skills and model configs of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`) across all your machines through any WebDAV server.

Install once on one machine — the rest follow automatically. Diverged entries are merged automatically and identical content is deduped, so no more repeated installs, manual `settings.yaml` copying, or late-night environment matching.

## Features

| Capability | Details |
| --- | --- |
| **Plugin sync** | Bundles from your profile are packed and uploaded; other machines download and install them automatically |
| **Skill sync** | Skill folders under `$DSH_HOME/skills` are synced as a whole — write once, use everywhere |
| **Model config sync** | Top-level keys of `settings.yaml`, merged key by key, opt-in and off by default |
| **Two-way or one-way** | Each machine independently picks two-way, upload-only, or download-only |
| **Content-addressed dedup** | SHA-256 addressing means the same content is transferred once; a remote file with the same content is reused across entries instead of being uploaded again |
| **Three-way merge** | The base is the last synced snapshot, so only entries changed on both sides count as divergent; the winner is decided by modification time, then by version, and the loser is backed up |
| **Automatic by default** | Auto resolution, install on download, propagated deletions, schedules that take effect on save — no manual conflict handling |
| **Deletion propagation** | Delete on one side and the other follows: the remote copy moves to `trash/`, the local copy is backed up first |
| **Live progress** | Stage, percentage, upload/download/merge/skip/delete counters and the current entry, cancellable while running |
| **Structured logs** | Written as JSONL by level and category (upload / download / merge / skip / delete / dedupe / conflict / connection / schedule / environment), filterable, searchable and exportable in the UI |
| **Dry-run analysis** | Preview the difference list (upload, download, merge or skip per entry) before syncing — reads only, writes nothing |
| **Automatic cleanup** | Remote tombstones and expired trash are pruned, and local backups rotate by count (10 kept by default) |

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

Restart dsh. The panel has two entry points and shows the same content:

- **Plugin detail page**: **Plugins** in the left sidebar → **Installed plugins** → click **WebDAV sync** (package `dsh-webdav-enhanced`). The panel fills the detail page and has 7 tabs, starting with **Overview**.
- **Settings dialog**: a standalone **WebDAV sync** page in the left navigation, backed by the same panel.

> The config page registers on three slots: `plugins.bundle.config`, `plugins.row.config` and `settings.section` (id `webdav-sync`). `locale/*.json` supplies the list title, description and detail document path, and `icon.svg` the artwork; without them dsh falls back to the package name and generic art.

## Quick start

1. **Read the Guide**: the **Guide** tab inside the panel is a card-based walkthrough — quick start, capability map, sync rules, server compatibility, security and FAQ.
2. **Connection**: enter your WebDAV URL, username and password, then click **Test connection**. The test walks through PROPFIND, MKCOL, PUT and read-back, and probes whether the server supports LOCK / If-Match.
3. **Content**: choose what to sync. Plugins and skills are on by default; model config is off.
4. **Mode**: pick a direction and an interval (e.g. every 1 hour). Two-way, no schedule, by default.
5. **Sync**: back on **Overview**, click **Analyse differences** to review the plan, then **Sync now**. The progress card shows the stage, percentage and per-entry results live.

Click **Save** on each tab. Once the connection test passes, you can run the first sync with **Sync now**.

## Settings tabs

The plugin detail page and the settings dialog share these 7 tabs, in this order:

| Tab | Contents |
| --- | --- |
| Overview | Status header (connection / machine / last sync / direction), sync now + progress card, last run counters, one-click **Analyse differences** result table |
| Guide | Card-based docs: quick start, capability map, sync rules, server compatibility, security, FAQ, about (version / machine ID / data directory) |
| Connection | URL, username, password, connection test, advanced options (timeout / remote root / ignore self-signed TLS), server capabilities |
| Content | Plugins / skills / config groups: mode selection, entry checklists, exclusions |
| Mode | Direction, schedule toggle and interval, conflict policy, smart option switches |
| Logs | Level and category filters, search, list, export, auto-refresh while running |
| Diagnostics | Environment key-values, lock holder, capabilities, re-probe, danger zone (reset local / clear remote) |

## Configuration

Most settings live in the settings panel; the rest is set through the profile's `cordis.patch.yml`:

| Field | Default | Notes |
| --- | --- | --- |
| `profile` | auto-detected | Which dsh profile to sync. Leave empty to detect from the profile that installed this plugin: `desktop` for the app, `web` for the Web GUI |
| `connection.url` / `connection.username` | empty | Also editable in the UI |
| `connection.password` | empty | First-run migration source only; the local credential file wins afterwards |
| `options.timeoutMs` | `30000` | Per-request WebDAV timeout in milliseconds |
| `options.remoteRoot` | `/dsh-sync/` | Remote sync root |
| `options.ignoreTlsErrors` | `false` | Self-signed intranet certificates only |
| `schedule.enabled` / `schedule.intervalHours` | `false` / `1` | Scheduled sync; saving takes effect immediately, no restart needed |
| `conflictPolicy` | `auto` | Conflict policy, see "Conflict policies" below |
| `syncOptions.propagateDeletions` | `true` | Propagate deletions: delete on one side, follow on the other |
| `syncOptions.autoResolve` | `'auto'` | Divergence resolution: `auto` / `local` / `remote` / `manual` |
| `syncOptions.dedupeRemote` | `true` | Cross-entry remote dedup: register the entry without re-uploading when the remote already has the same hash |
| `syncOptions.autoInstall` | `true` | Install after download: bundles via plugin install, skills unzipped, config merged by key |
| `syncOptions.contentMerge` | `true` | Merge config by top-level key rather than replacing the file wholesale |
| `syncOptions.maxBackups` | `10` | Local backups kept per entry kind; oldest removed beyond that |
| `syncOptions.pruneTombstones` | `true` | Prune remote tombstones and expired trash after a run |
| `syncOptions.hardDelete` | `false` | Physically delete remote tombstones after a run (off means trash only) |
| `scope.*` | plugins + skills `all`, config `none` | What to sync |

## What gets synced

- **Plugins**: profile `package.json` dependencies marked with `dsh.bundle`, packed from their local paths.
- **Skills**: every folder under `$DSH_HOME/skills` that contains a `SKILL.md`, including all files inside.
- **Config**: top-level keys of `settings.yaml`, narrowed with `includeKeys` when needed. `.credentials.yaml` never participates, and neither do sensitive top-level keys such as `apiKey` and `credentials`.

With scope mode `all`, every non-sensitive top-level key is synced; with mode `custom`, only the keys listed in `includeKeys` are touched.

> Scope applies in both directions: a kind set to "skip", or an entry added to the exclude list, is neither uploaded nor downloaded from the remote, and deletion propagation leaves it alone.

## Conflict policies

Since v0.4.0 the default policy is `auto`: an entry only diverges when both sides changed it, and then the winner is chosen automatically by modification time, then version, then remote precedence; the loser is backed up. **No conflicts are left for you to resolve.**

| Policy | Behaviour |
| --- | --- |
| **`auto`** (default) | Newer modification time wins when the gap exceeds 2 seconds; within 2 seconds the higher version wins; still tied means remote wins (so two machines cannot keep kicking each other). The loser is backed up automatically |
| **`merge-backup`** | Legacy: on divergence, download the remote version and back up the local one |
| **`ask`** | Legacy: only when explicitly selected — no resolution; conflicts land in the report and are flagged in the UI |
| **`local-wins`** | Local always wins: upload the local version over the remote (remote old version goes to `trash/`) |
| **`remote-wins`** | Remote always wins: download the remote version over the local (local old version is backed up first) |

To opt out of automatic mode and review every conflict by hand, set `conflictPolicy` to `ask`; otherwise the default is what you want.

## Server compatibility

| Server | Notes |
| --- | --- |
| **Nextcloud / ownCloud** | Fully supported; use an app password instead of your login password |
| **Jianguoyun (坚果云)** | Works after enabling WebDAV in account settings; use the app password and keep the interval ≥ 1 hour due to rate limits |
| **Synology** | Fully supported with the WebDAV Server package |
| **AList** | Fully supported with any storage driver |
| **Self-hosted** | Any RFC 4918 implementation; without LOCK / If-Match it degrades to soft locks and conflict copies |

## Security

- **API keys are never synced by default**: `.credentials.yaml` never participates; sensitive top-level keys such as `apiKey` in `settings.yaml` never participate either; config sync is off unless you enable it.
- **Credentials stay local**: the WebDAV password is written to `$DSH_HOME/.webdav-enhanced/credentials.json` (mode 0600). It never enters the cordis config, never reaches the server, and never appears in any API response.
- **Integrity checks**: every zip is content-addressed by SHA-256 and verified on download.
- **Deletions are recoverable**: remote deletions sit in `trash/` for 7 days and local deletions are backed up first, so a mistake can be undone from either side.
- **Extraction guards**: path traversal and zip bombs are rejected; 128MB per file, 512MB total.

## Remote layout

```
/dsh-sync/
├── manifest.json        # Global ledger: entries, hashes, versions, source machines, deletion tombstones
├── locks/sync.lock      # Soft lock (native LOCK when supported)
├── bundles/*.zip        # Content-addressed plugin packages
├── skills/*.zip         # Content-addressed skill packages
├── configs/*.zip        # settings.yaml fragments (opt-in)
└── trash/               # Recoverable copies from deletions and conflicts, pruned when expired
```

Each run prunes tombstones and trash older than 7 days, controlled by `syncOptions.pruneTombstones` and `hardDelete`.

## Local layout

```
$DSH_HOME/.webdav-enhanced/
├── webdav-enhanced.json     # Sync config and state (no password)
├── credentials.json         # WebDAV password (0600, never committed, never uploaded)
├── hash-cache.json          # Scan hash cache, speeds up difference analysis
├── backups/<kind>s/         # Local backups before merge or overwrite, rotated by maxBackups
└── logs/sync.jsonl          # Structured logs (>1MB rotates to sync.1.jsonl)
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
| No panel on the plugin page | The panel has two entry points: the plugin detail page and the settings dialog | Plugins → Installed plugins → WebDAV sync, or **WebDAV sync** in the settings dialog — same panel in both places |
| Progress card stuck on one stage | A large file, server throttling, or waiting for the soft lock | Check the newest message in the **Logs** tab; if it stays stuck, cancel, then check the network and the remote lock; on rate-limited servers such as Jianguoyun keep the interval ≥ 1 hour |
| Where are the logs | Both in the UI and on disk | **Logs** tab for filter, search and export; the file is `$DSH_HOME/.webdav-enhanced/logs/sync.jsonl` |
| Where are the backups | Old versions from merges and overwrites | `$DSH_HOME/.webdav-enhanced/backups/<kind>s/`, rotated by `syncOptions.maxBackups` (10 kept by default) |
| Can automatic merge lose data | No | The losing version is backed up and remote deletions stay in `trash/`; set `conflictPolicy` to `ask` if you want to confirm everything by hand |
| Want to preview before syncing | Dry-run analysis | Overview → **Analyse differences**: lists the plan and writes nothing |
| Schedule change ignored | Older versions needed a restart | Since v0.4.0 saving takes effect immediately; if it still does not run, check the schedule category in **Logs** |
| Only the package name, no icon | Missing `dsh.client` or `icon` / `locale` exports | Built in since 0.3.0; make sure you installed `>=0.3.0` |
| HTTP 401 on test | Wrong credentials | Nextcloud and Jianguoyun need an app password |
| HTTP 423 on MKCOL / PUT | Remote directory is locked | **Test connection** no longer locks directories; if it persists, wait 10–60 seconds or restart the WebDAV server to clear stale locks |
| Read-back returns 404 | The previous PUT did not land | Fix 423 / 403 first; a missing file always reads back as 404 |
| HTTP 405 on MKCOL | Directory already exists | Harmless, sync continues |
| HTTP 412 during sync | Remote changed mid-merge | Automatic retry (3 attempts); persistent failures mean another machine is syncing |
| Sync is slow | Large files in a synced folder | `node_modules` is excluded automatically; add others to the exclude list, and use **Analyse differences** first to see how much this run will touch |
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
