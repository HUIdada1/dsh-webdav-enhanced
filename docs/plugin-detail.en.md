# WebDAV sync

Keep plugins, skills and model config aligned across all your machines through one WebDAV server: configure one machine, the rest follow.

The panel has two entry points and shows the same content:

- **Plugin detail page**: Plugins → Installed plugins → WebDAV sync. The panel renders right on the detail page and has 7 tabs.
- **Settings dialog**: **WebDAV sync** in the left navigation opens the same panel whenever you need it.

New here? Read the **Guide** tab inside the panel first, then take three steps:

1. **Connection**: enter the URL, username and password, then click **Test connection**. The test walks through PROPFIND, MKCOL, PUT and read-back, and probes whether the server supports LOCK / If-Match.
2. **Content**: pick what to sync. Plugins and skills are on by default; model config is off.
3. **Mode**: choose direction and interval, then click **Save** on each tab. To preview first, go back to **Overview** and click **Analyse differences** — it only lists a plan and writes nothing.

## Three things worth knowing

- **Fully automatic by default, no conflict prompts.** When both sides diverge, the newer side wins by modification time, then by version; the loser is backed up automatically to `$DSH_HOME/.webdav-enhanced/backups/`. The log says who won, and nothing needs manual handling.
- **The password never leaves this machine.** It lives in `$DSH_HOME/.webdav-enhanced/credentials.json` (mode 0600); it never enters the config, never reaches the server, and never appears in any API response.
- **Config sync is opt-in.** `settings.yaml` can hold API keys; enable it deliberately or narrow it with "only these top-level keys".

## What gets synced

- **Plugins**: dependencies in the profile marked with `dsh.bundle`, packed from their local paths.
- **Skills**: every folder under `$DSH_HOME/skills` that contains a `SKILL.md`, synced as a whole.
- **Config**: top-level keys of `settings.yaml`, off by default; `.credentials.yaml` and sensitive keys such as `apiKey` never participate.

## What you can watch

The progress card under **Overview** shows the stage, percentage, upload/download/merge/skip/delete counters and the current entry, and a run can be cancelled at any time. The **Logs** tab records every operation by level and category, with filtering, search and export.

## Supported servers

Nextcloud / ownCloud, Jianguoyun (app password), Synology WebDAV Server, AList, and any RFC 4918 implementation. Without LOCK / If-Match it degrades to a soft lock.

See `README.md` in the package for the full reference: config fields, merge rules, conflict policies and FAQ.
