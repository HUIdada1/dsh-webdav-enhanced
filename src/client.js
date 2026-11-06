/*
 * WebDAV Sync —— dsh 插件配置面板（浏览器半侧，dsh 模块格式）。
 *
 * 挂载点（两处，任一处能被用户找到即可）：
 *   1. plugins.bundle.config —— 插件 → 已安装插件 → dsh-webdav-enhanced 详情页
 *   2. plugins.row.config    —— 同一详情页里该行多出的「配置」入口
 * 插槽只有在插件页打开时才存在，因此用 ctx.slots.inject 等待，不要假设它已就绪。
 *
 * 设计约束（踩过的坑，勿回退）：
 *   - 面板渲染在插件详情页的「详细文档」之后，文档越长面板越难被发现 → 面板自身必须
 *     紧凑、首屏给出标题与主操作，且包内 meta.detail 指向短文档。
 *   - DOM 构造一律走 h(tag, cls, ...children)，children 可以是字符串或节点；
 *     旧实现把节点当文本传，按钮全变成 "[object HTMLButtonElement]"。
 *   - 颜色只用 --dsw-alias-* 设计令牌并带回退，浅色/深色主题都不写死色值。
 *   - 零依赖：不 import 任何模块，只 require('react')。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdav-enhanced',
  factory: (require) => {
    'use strict'

    const React = require('react')

    const NS = 'webdav-enhanced'
    const PKG = 'dsh-webdav-enhanced'
    /** cordis.patch.yml 里那一行的 id，行级配置插槽的 key 需要用 `<包名>#<行 id>` */
    const ROW_ID = 'webdav-enhanced'
    const API_BASE = '/api/webdav-enhanced'

    // ---------------------------------------------------------------- i18n

    const i18n = {
      zh: {
        title: 'WebDAV 同步',
        subtitle: '用一台 WebDAV 服务器在机器之间同步插件、技能与模型配置',
        nav: {
          connect: '连接',
          scope: '同步内容',
          mode: '同步方式',
          history: '记录与诊断',
          danger: '危险区',
        },
        state: {
          unconfigured: '未配置',
          configured: '已配置',
          never: '从未同步',
          last: '上次同步',
          running: '同步中…',
        },
        connect: {
          url: 'WebDAV 地址',
          urlHint: '例如 https://dav.example.com/dsh/',
          username: '账号',
          password: '密码',
          passwordHint: '留空表示不修改已保存的密码',
          test: '测试连接',
          testing: '测试中…',
          ok: '连接成功',
          fail: '连接失败',
          advanced: '高级选项',
          timeout: '超时（毫秒）',
          remoteRoot: '远端同步根目录',
          tls: '忽略 TLS 证书错误（仅限内网自签证书）',
          save: '保存连接',
          saved: '已保存',
          server: '服务端',
          http: {
            401: '认证失败：账号或密码不正确。坚果云 / Nextcloud 请用应用专用密码；改过密码的话在密码框重新输入并保存',
            403: '没有写权限：账号只读，或该目录被限制',
            404: '目标不存在：地址可能少了一层路径',
            405: '服务端不允许这个操作',
            409: '父目录不存在，或路径冲突',
            423: '远端被锁定：多为上一次测试/同步残留的 LOCK，等 10–60 秒、或在服务端解除锁后重试',
            507: '远端空间不足',
          },
        },
        scope: {
          bundles: '插件',
          skills: '技能',
          configs: '模型与配置',
          all: '全部同步',
          selected: '仅勾选的条目',
          none: '不同步',
          exclude: '排除的条目名（逗号分隔）',
          includeKeys: '只同步这些顶层 key（逗号分隔）',
          tip: '配置同步默认关闭：settings.yaml 里可能含 API Key，启用前请确认。',
          save: '保存同步内容',
        },
        mode: {
          direction: '同步方向',
          both: '双向（推荐）',
          upload: '仅上传',
          download: '仅下载',
          schedule: '定时同步',
          interval: '间隔',
          hours: '小时',
          conflictPolicy: '冲突策略',
          'merge-backup': '自动合并并保留本地备份（推荐）',
          ask: '冲突时标记提醒',
          'local-wins': '总是本机优先',
          'remote-wins': '总是远端优先',
          save: '保存同步方式',
        },
        history: {
          env: '环境',
          reprobe: '重新探测',
          logs: '最近日志',
          empty: '暂无记录',
          lock: '当前锁',
          free: '无（可同步）',
          refresh: '刷新',
        },
        danger: {
          reset: '重置本机同步状态',
          resetConfirm: '将清空本机的同步记录与缓存，远端数据不受影响。确定继续？',
          clearRemote: '清空远端同步数据',
          clearConfirm: '将删除 WebDAV 上的全部同步文件，且不可恢复。输入 DELETE 确认：',
          deleted: '已清空',
        },
        common: {
          save: '保存',
          saved: '已保存',
          syncNow: '立即同步',
          error: '错误',
          ok: '完成',
          loading: '加载中…',
          notFound: '未探测到',
        },
      },
      en: {
        title: 'WebDAV sync',
        subtitle: 'Keep plugins, skills and model config in sync across machines through one WebDAV server',
        nav: {
          connect: 'Connection',
          scope: 'Content',
          mode: 'Mode',
          history: 'Diagnostics',
          danger: 'Danger zone',
        },
        state: {
          unconfigured: 'Not configured',
          configured: 'Configured',
          never: 'Never synced',
          last: 'Last sync',
          running: 'Syncing…',
        },
        connect: {
          url: 'WebDAV URL',
          urlHint: 'e.g. https://dav.example.com/dsh/',
          username: 'Username',
          password: 'Password',
          passwordHint: 'Leave blank to keep the saved password',
          test: 'Test connection',
          testing: 'Testing…',
          ok: 'Connected',
          fail: 'Failed',
          advanced: 'Advanced',
          timeout: 'Timeout (ms)',
          remoteRoot: 'Remote sync root',
          tls: 'Ignore TLS errors (self-signed intranet only)',
          save: 'Save connection',
          saved: 'Saved',
          server: 'Server',
          http: {
            401: 'Authentication failed: wrong username or password. Use an app password for Nutstore / Nextcloud, and re-enter the password here if it changed',
            403: 'No write permission: read-only account or restricted folder',
            404: 'Not found: the URL may be missing a path segment',
            405: 'The server rejects this operation',
            409: 'Missing parent collection or path conflict',
            423: 'Locked on the server: usually a LOCK left by an earlier test/sync. Wait 10–60s or release it on the server',
            507: 'Not enough remote space',
          },
        },
        scope: {
          bundles: 'Plugins',
          skills: 'Skills',
          configs: 'Models & config',
          all: 'Everything',
          selected: 'Only selected items',
          none: 'Skip',
          exclude: 'Excluded item names (comma separated)',
          includeKeys: 'Only these top-level keys (comma separated)',
          tip: 'Config sync is off by default: settings.yaml may hold API keys.',
          save: 'Save content',
        },
        mode: {
          direction: 'Direction',
          both: 'Two-way (recommended)',
          upload: 'Upload only',
          download: 'Download only',
          schedule: 'Scheduled sync',
          interval: 'Every',
          hours: 'hours',
          conflictPolicy: 'Conflict policy',
          'merge-backup': 'Merge and keep a local backup (recommended)',
          ask: 'Flag conflicts',
          'local-wins': 'Always local wins',
          'remote-wins': 'Always remote wins',
          save: 'Save mode',
        },
        history: {
          env: 'Environment',
          reprobe: 'Re-probe',
          logs: 'Recent logs',
          empty: 'Nothing yet',
          lock: 'Current lock',
          free: 'None (ready)',
          refresh: 'Refresh',
        },
        danger: {
          reset: 'Reset local sync state',
          resetConfirm: 'Clears local sync records and cache. Remote data is untouched. Continue?',
          clearRemote: 'Clear remote sync data',
          clearConfirm: 'Deletes every sync file on WebDAV (irreversible). Type DELETE to confirm:',
          deleted: 'Cleared',
        },
        common: {
          save: 'Save',
          saved: 'Saved',
          syncNow: 'Sync now',
          error: 'Error',
          ok: 'Done',
          loading: 'Loading…',
          notFound: 'not found',
        },
      },
    }

    /** 把嵌套词典压平成 dsh locale 需要的点号 key */
    function flattenDict(node, prefix, out) {
      const result = out || {}
      for (const key of Object.keys(node)) {
        const value = node[key]
        const full = prefix ? prefix + '.' + key : key
        if (value && typeof value === 'object') flattenDict(value, full, result)
        else result[full] = value
      }
      return result
    }

    // --------------------------------------------------------------- 工具

    /** 创建元素：children 可以是字符串或 DOM 节点（旧实现只接受字符串，节点被当成文本） */
    function h(tag, cls, ...children) {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      for (const child of children) {
        if (child === null || child === undefined || child === false) continue
        node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
      }
      return node
    }

    function field(labelText, control, hint) {
      const wrap = h('label', 'wds-field')
      if (labelText) wrap.appendChild(h('span', 'wds-label', labelText))
      wrap.appendChild(control)
      if (hint) wrap.appendChild(h('span', 'wds-hint', hint))
      return wrap
    }

    function input(type, value, placeholder) {
      const node = document.createElement('input')
      node.type = type
      node.className = 'wds-input'
      if (value !== undefined && value !== null) node.value = String(value)
      if (placeholder) node.placeholder = placeholder
      return node
    }

    function select(options, value) {
      const node = document.createElement('select')
      node.className = 'wds-input'
      for (const [val, label] of options) {
        const opt = document.createElement('option')
        opt.value = val
        opt.textContent = label
        node.appendChild(opt)
      }
      if (value !== undefined) node.value = value
      return node
    }

    function checkbox(labelText, checked) {
      const wrap = h('label', 'wds-check')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = !!checked
      wrap.append(box, h('span', '', labelText))
      wrap.input = box
      return wrap
    }

    function button(labelText, variant) {
      const node = h('button', 'wds-btn' + (variant ? ' wds-btn-' + variant : ''), labelText)
      node.type = 'button'
      return node
    }

    async function api(path, options) {
      const opts = options || {}
      const res = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      const text = await res.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      if (!res.ok) {
        const detail = parsed && parsed.error ? parsed.error : text || 'HTTP ' + res.status
        throw new Error(detail)
      }
      return parsed
    }

    function splitList(value) {
      return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }

    function joinList(list) {
      return Array.isArray(list) ? list.join(', ') : ''
    }

    function formatTime(iso, locale) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')
      } catch {
        return iso
      }
    }

    // ---------------------------------------------------------------- 样式

    const css = `
    .wds-host { display: block; }
    .wds-root {
      --wds-line: var(--dsw-alias-border-l2, rgba(127, 127, 127, .26));
      --wds-line-strong: var(--dsw-alias-border-l3, rgba(127, 127, 127, .38));
      --wds-surface: var(--dsw-alias-bg-layer-1, transparent);
      --wds-surface-soft: var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, .06));
      --wds-accent: var(--dsw-alias-state-business-primary, #4176e6);
      --wds-success: var(--dsw-alias-state-success-primary, #22c55e);
      --wds-warn: var(--dsw-alias-state-warn-label, #dd8629);
      --wds-danger: var(--dsw-alias-state-error-primary, #ec1313);
      --wds-primary: var(--dsw-alias-button-primary-fill, #0f1115);
      --wds-primary-text: var(--dsw-alias-bg-base, #fff);
      --wds-muted: color-mix(in srgb, currentColor 58%, transparent);
      display: block;
      max-width: 760px;
      color: inherit;
      font-size: 13px;
      line-height: 1.55;
    }
    .wds-root *, .wds-root *::before, .wds-root *::after { box-sizing: border-box; }

    .wds-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px;
      border: 1px solid var(--wds-line); border-radius: var(--dsw-radius-md, 12px);
      background: var(--wds-surface-soft); }
    .wds-head-mark { width: 34px; height: 34px; flex: 0 0 34px; color: var(--wds-accent); }
    .wds-head-text { flex: 1 1 auto; min-width: 0; }
    .wds-head-title { font-size: 14px; font-weight: 600; }
    .wds-head-sub { font-size: 12px; color: var(--wds-muted); }
    .wds-pill { flex: 0 0 auto; font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 999px;
      border: 1px solid var(--wds-line-strong); color: var(--wds-muted); white-space: nowrap; }
    .wds-pill.on { color: var(--wds-success); border-color: color-mix(in srgb, var(--wds-success) 45%, transparent); }
    .wds-pill.off { color: var(--wds-warn); border-color: color-mix(in srgb, var(--wds-warn) 45%, transparent); }

    .wds-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 12px 0 14px; }
    .wds-tab { padding: 5px 11px; border-radius: 999px; border: 1px solid transparent; cursor: pointer;
      color: var(--wds-muted); background: transparent; font: inherit; }
    .wds-tab:hover { background: var(--wds-surface-soft); }
    .wds-tab.active { color: var(--wds-accent); background: color-mix(in srgb, var(--wds-accent) 10%, transparent);
      border-color: color-mix(in srgb, var(--wds-accent) 35%, transparent); }

    .wds-pane { display: none; }
    .wds-pane.active { display: block; }

    .wds-field { display: block; margin-bottom: 12px; }
    .wds-label { display: block; font-size: 12px; color: var(--wds-muted); margin-bottom: 5px; }
    .wds-hint { display: block; font-size: 11px; color: var(--wds-muted); margin-top: 4px; }
    .wds-input { width: 100%; padding: 7px 10px; font: inherit; color: inherit;
      background: var(--wds-surface); border: 1px solid var(--wds-line); border-radius: var(--dsw-radius-sm, 8px);
      outline: none; }
    .wds-input:focus { border-color: var(--wds-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--wds-accent) 22%, transparent); }
    .wds-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }

    .wds-check { display: flex; align-items: center; gap: 8px; margin: 2px 0 12px; cursor: pointer; }
    .wds-check input { margin: 0; }

    .wds-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
    .wds-btn { padding: 6px 14px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer;
      font: inherit; color: inherit; background: var(--wds-surface); border: 1px solid var(--wds-line-strong); }
    .wds-btn:hover:not(:disabled) { background: var(--wds-surface-soft); }
    .wds-btn:disabled { opacity: .55; cursor: not-allowed; }
    .wds-btn-primary { background: var(--wds-primary); color: var(--wds-primary-text); border-color: transparent; }
    .wds-btn-primary:hover:not(:disabled) { opacity: .9; background: var(--wds-primary); }
    .wds-btn-danger { color: var(--wds-danger); border-color: color-mix(in srgb, var(--wds-danger) 45%, transparent); }

    .wds-status { margin-top: 12px; padding: 8px 11px; border-radius: var(--dsw-radius-sm, 8px);
      font-size: 12px; border: 1px solid var(--wds-line); background: var(--wds-surface-soft); display: none;
      white-space: pre-line; }
    .wds-status.show { display: block; }
    .wds-status.ok { border-color: color-mix(in srgb, var(--wds-success) 45%, transparent);
      color: var(--wds-success); }
    .wds-status.err { border-color: color-mix(in srgb, var(--wds-danger) 45%, transparent);
      color: var(--wds-danger); }

    .wds-tip { padding: 8px 11px; border-radius: var(--dsw-radius-sm, 8px); font-size: 12px;
      color: var(--wds-muted); background: var(--wds-surface-soft); border: 1px solid var(--wds-line); margin-bottom: 12px; }

    .wds-group { border: 1px solid var(--wds-line); border-radius: var(--dsw-radius-md, 12px);
      padding: 12px 14px; margin-bottom: 12px; }
    .wds-group-title { font-weight: 600; margin-bottom: 8px; }
    .wds-list { max-height: 190px; overflow: auto; border: 1px solid var(--wds-line);
      border-radius: var(--dsw-radius-sm, 8px); margin: 8px 0; }
    .wds-list:empty { display: none; }
    .wds-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px;
      border-bottom: 1px solid var(--wds-line); }
    .wds-row:last-child { border-bottom: none; }
    .wds-row-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wds-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; color: var(--wds-muted);
      background: var(--wds-surface-soft); border: 1px solid var(--wds-line); }
    .wds-kv { display: grid; grid-template-columns: 82px 1fr; gap: 4px 10px; font-size: 12px; margin-bottom: 12px; }
    .wds-kv dt { color: var(--wds-muted); }
    .wds-kv dd { margin: 0; word-break: break-all; }
    .wds-scroll { max-height: 220px; overflow: auto; }
    @media (max-width: 640px) {
      .wds-grid-2 { grid-template-columns: 1fr; }
      .wds-kv { grid-template-columns: 1fr; }
    }
    `

    // ------------------------------------------------------------- 面板实现

    const LOCALE = { zh: flattenDict(i18n.zh), en: flattenDict(i18n.en) }

    async function mount(root, locale) {
      const t = i18n[locale] || i18n.zh
      root.textContent = ''

      const style = document.createElement('style')
      style.textContent = css
      root.appendChild(style)

      const shell = h('div', 'wds-root')
      root.appendChild(shell)

      /** 头部：标题 + 状态 + 主操作 */
      const pill = h('span', 'wds-pill', t.common.loading)
      const syncBtn = button(t.common.syncNow, 'primary')
      const head = h(
        'div',
        'wds-head',
        headerMark(),
        h('div', 'wds-head-text', h('div', 'wds-head-title', t.title), h('div', 'wds-head-sub', t.subtitle)),
        pill,
        syncBtn,
      )
      shell.appendChild(head)

      /** 页签 */
      const panes = {}
      const tabButtons = {}
      const tabs = h('div', 'wds-tabs')
      const order = ['connect', 'scope', 'mode', 'history', 'danger']
      for (const key of order) {
        const tab = h('button', 'wds-tab', t.nav[key])
        tab.type = 'button'
        tab.onclick = () => activate(key)
        tabButtons[key] = tab
        tabs.appendChild(tab)
      }
      shell.appendChild(tabs)

      const body = h('div', 'wds-body')
      shell.appendChild(body)

      panes.connect = buildConnect()
      panes.scope = buildScope()
      panes.mode = buildMode()
      panes.history = buildHistory()
      panes.danger = buildDanger()
      for (const key of order) body.appendChild(panes[key])

      activate('connect')

      function activate(key) {
        for (const name of order) {
          tabButtons[name].classList.toggle('active', name === key)
          panes[name].classList.toggle('active', name === key)
        }
        if (key === 'history' && panes.history && panes.history.refreshHistory) void panes.history.refreshHistory()
        if (key === 'scope') void refreshScopeList()
      }

      function headerMark() {
        const wrap = h('span', 'wds-head-mark')
        wrap.innerHTML =
          '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M6.5 18.5a3.5 3.5 0 0 1-.4-6.98A5 5 0 0 1 15.6 9.6a4 4 0 0 1 2.06 7.75"/>' +
          '<path d="M9.2 14.2 7.6 15.8l1.6 1.6"/><path d="M14.8 14.2l1.6 1.6-1.6 1.6"/>' +
          '<path d="M8 15.8h7"/></svg>'
        return wrap
      }

      // ---------- 通用：状态条 ----------
      function status(parent) {
        const box = h('div', 'wds-status')
        parent.appendChild(box)
        return {
          show(kind, message) {
            box.className = 'wds-status show ' + kind
            box.textContent = message
          },
          clear() {
            box.className = 'wds-status'
            box.textContent = ''
          },
        }
      }

      // ---------- 页签 1：连接 ----------
      function buildConnect() {
        const pane = h('div', 'wds-pane')
        const url = input('text', '', t.connect.urlHint)
        const user = input('text', '', '')
        const pass = input('password', '', t.connect.passwordHint)
        const timeout = input('number', '30000', '30000')
        const remoteRoot = input('text', '/dsh-sync/', '/dsh-sync/')
        const tls = checkbox(t.connect.tls, false)

        const advanced = h(
          'div',
          'wds-advanced',
          h('div', 'wds-grid-2', field(t.connect.timeout, timeout), field(t.connect.remoteRoot, remoteRoot)),
          tls,
        )
        advanced.style.display = 'none'
        const advToggle = button('▸ ' + t.connect.advanced)
        advToggle.onclick = () => {
          const hidden = advanced.style.display === 'none'
          advanced.style.display = hidden ? 'block' : 'none'
          advToggle.textContent = (hidden ? '▾ ' : '▸ ') + t.connect.advanced
        }

        const testBtn = button(t.connect.test)
        const saveBtn = button(t.connect.save, 'primary')
        const state = status(pane)

        pane.append(
          field(t.connect.url, url),
          h('div', 'wds-grid-2', field(t.connect.username, user), field(t.connect.password, pass)),
          h('div', 'wds-actions', advToggle),
          advanced,
          h('div', 'wds-actions', testBtn, saveBtn),
        )

        testBtn.onclick = async () => {
          testBtn.disabled = true
          const label = testBtn.textContent
          testBtn.textContent = t.connect.testing
          state.clear()
          try {
            const r = await api('/test', {
              method: 'POST',
              body: {
                url: url.value.trim(),
                username: user.value.trim(),
                password: pass.value,
                timeoutMs: Number(timeout.value) || undefined,
                remoteRoot: remoteRoot.value.trim() || undefined,
                ignoreTlsErrors: tls.input.checked,
              },
            })
            const steps = r.steps || []
            const marks = steps.map((s) => s.step + (s.ok ? ' ✓' : ' ✗')).join(' · ')
            const server = r.capabilities && r.capabilities.server
            if (r.ok) {
              state.show('ok', t.connect.ok + (marks ? ' — ' + marks : '') + (server ? ' · ' + t.connect.server + ': ' + server : ''))
            } else {
              // 每个失败步骤只报「步骤 + 状态码」，提示按码去重后单独一行，避免同一句话刷四遍
              const hints = t.connect.http || {}
              const failed = steps.filter((s) => !s.ok)
              const marks = failed.map((s) => s.step + ' ✗ ' + String(s.detail || '').replace(/^HTTP\s+/, '')).join(' · ')
              const codes = [...new Set(failed.map((s) => String(s.detail || '').replace(/^HTTP\s+/, '').trim()))]
              const hint = codes.map((code) => hints[code]).filter(Boolean).join('；')
              state.show('err', t.connect.fail + (marks ? ' — ' + marks : '') + (hint ? '\n' + hint : ''))
            }
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            testBtn.disabled = false
            testBtn.textContent = label
          }
        }

        saveBtn.onclick = async () => {
          saveBtn.disabled = true
          try {
            await api('/config', {
              method: 'POST',
              body: {
                connection: {
                  url: url.value.trim(),
                  username: user.value.trim(),
                  password: pass.value,
                  passwordRef: 'credentials',
                },
                options: {
                  timeoutMs: Number(timeout.value) || 30000,
                  remoteRoot: remoteRoot.value.trim() || '/dsh-sync/',
                  ignoreTlsErrors: tls.input.checked,
                },
              },
            })
            pass.value = ''
            state.show('ok', t.connect.saved)
            // 重新读一遍：pill 的「已配置 / 上次同步」依赖 current，只刷状态会读到旧值
            await refreshConfig()
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            saveBtn.disabled = false
          }
        }

        pane.fill = (cfg) => {
          url.value = cfg.connection?.url || ''
          user.value = cfg.connection?.username || ''
          pass.value = ''
          const opts = cfg.options || {}
          timeout.value = String(opts.timeoutMs || 30000)
          remoteRoot.value = opts.remoteRoot || '/dsh-sync/'
          tls.input.checked = opts.ignoreTlsErrors === true
        }
        return pane
      }

      // ---------- 页签 2：同步内容 ----------
      function buildScope() {
        // 状态放在函数作用域内：外面用 const 声明会在 buildScope 提前调用时撞上 TDZ
        const scopeState = {
          bundles: { mode: 'all', exclude: [] },
          skills: { mode: 'all', exclude: [] },
          configs: { mode: 'none', includeKeys: [] },
        }
        const scopeLists = {}
        const scopeExtras = {}
        const scopeSelects = {}
        const pane = h('div', 'wds-pane')
        const groups = [
          { key: 'bundles', label: t.scope.bundles },
          { key: 'skills', label: t.scope.skills },
          { key: 'configs', label: t.scope.configs },
        ]

        for (const group of groups) {
          const modeSel = select(
            [
              ['all', t.scope.all],
              ['selected', t.scope.selected],
              ['none', t.scope.none],
            ],
            scopeState[group.key].mode,
          )
          const list = h('div', 'wds-list')
          scopeLists[group.key] = list
          scopeSelects[group.key] = modeSel
          const extra = input('text', '', '')
          scopeExtras[group.key] = extra

          const wrap = h(
            'div',
            'wds-group',
            h('div', 'wds-group-title', group.label),
            field('', modeSel),
            list,
            field(group.key === 'configs' ? t.scope.includeKeys : t.scope.exclude, extra),
          )
          if (group.key === 'configs') wrap.appendChild(h('div', 'wds-tip', t.scope.tip))

          modeSel.onchange = () => {
            scopeState[group.key].mode = modeSel.value
            void renderList(group.key)
          }
          extra.onchange = () => {
            const values = splitList(extra.value)
            if (group.key === 'configs') scopeState.configs.includeKeys = values
            else scopeState[group.key].exclude = values
          }
          wrap.fillExtra = () => {
            extra.value =
              group.key === 'configs' ? joinList(scopeState.configs.includeKeys) : joinList(scopeState[group.key].exclude)
          }
          pane.appendChild(wrap)
        }

        const saveBtn = button(t.scope.save, 'primary')
        const state = status(pane)
        saveBtn.onclick = async () => {
          saveBtn.disabled = true
          try {
            await api('/config', { method: 'POST', body: { scope: scopeState } })
            state.show('ok', t.common.saved)
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            saveBtn.disabled = false
          }
        }
        pane.appendChild(h('div', 'wds-actions', saveBtn))

        async function renderList(kind) {
          const list = scopeLists[kind]
          list.textContent = ''
          if (scopeState[kind].mode !== 'selected') return
          try {
            const items = await api('/items?kind=' + kind)
            const excluded = new Set(scopeState[kind].exclude || [])
            if (!items.length) {
              list.appendChild(h('div', 'wds-row', h('span', 'wds-row-name', t.history.empty)))
              return
            }
            for (const item of items) {
              const box = document.createElement('input')
              box.type = 'checkbox'
              box.checked = !excluded.has(item.name)
              box.onchange = () => {
                const next = new Set(scopeState[kind].exclude || [])
                if (box.checked) next.delete(item.name)
                else next.add(item.name)
                scopeState[kind].exclude = [...next]
                if (scopeExtras[kind]) scopeExtras[kind].value = joinList(scopeState[kind].exclude)
              }
              list.appendChild(
                h('div', 'wds-row', box, h('span', 'wds-row-name', item.name), h('span', 'wds-badge', item.version || item.kind)),
              )
            }
          } catch (err) {
            list.appendChild(h('div', 'wds-row', h('span', 'wds-row-name', t.common.error + ': ' + err.message)))
          }
        }

        pane.fill = (cfg) => {
          const scope = cfg.scope || {}
          for (const key of ['bundles', 'skills', 'configs']) {
            const value = scope[key] || {}
            scopeState[key] = {
              mode: value.mode || (key === 'configs' ? 'none' : 'all'),
              exclude: Array.isArray(value.exclude) ? value.exclude.slice() : [],
              includeKeys: Array.isArray(value.includeKeys) ? value.includeKeys.slice() : [],
            }
            const modeSel = scopeSelects[key]
            if (modeSel) modeSel.value = scopeState[key].mode
            const extra = scopeExtras[key]
            if (extra) {
              extra.value = key === 'configs' ? joinList(scopeState.configs.includeKeys) : joinList(scopeState[key].exclude)
            }
            void renderList(key)
          }
        }
        pane.refreshScopeList = () => Promise.all(['bundles', 'skills', 'configs'].map(renderList))
        return pane
      }

      function refreshScopeList() {
        if (panes.scope.refreshScopeList) return panes.scope.refreshScopeList()
        return Promise.resolve()
      }

      // ---------- 页签 3：同步方式 ----------
      function buildMode() {
        const pane = h('div', 'wds-pane')
        const direction = select(
          [
            ['both', t.mode.both],
            ['upload', t.mode.upload],
            ['download', t.mode.download],
          ],
          'both',
        )
        const schedule = checkbox(t.mode.schedule, false)
        const interval = input('number', '1', '1')
        interval.min = '0.5'
        interval.step = '0.5'
        const policy = select(
          [
            ['merge-backup', t.mode['merge-backup']],
            ['ask', t.mode.ask],
            ['local-wins', t.mode['local-wins']],
            ['remote-wins', t.mode['remote-wins']],
          ],
          'merge-backup',
        )
        const saveBtn = button(t.mode.save, 'primary')
        const state = status(pane)

        saveBtn.onclick = async () => {
          saveBtn.disabled = true
          try {
            await api('/config', {
              method: 'POST',
              body: {
                schedule: {
                  enabled: schedule.input.checked,
                  intervalHours: Math.max(0.5, Number(interval.value) || 1),
                  direction: direction.value,
                },
                conflictPolicy: policy.value,
              },
            })
            state.show('ok', t.common.saved)
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            saveBtn.disabled = false
          }
        }

        pane.append(
          field(t.mode.direction, direction),
          schedule,
          h('div', 'wds-grid-2', field(t.mode.interval + ' · ' + t.mode.hours, interval)),
          field(t.mode.conflictPolicy, policy),
          h('div', 'wds-actions', saveBtn),
        )

        pane.fill = (cfg) => {
          const sched = cfg.schedule || {}
          direction.value = sched.direction || 'both'
          schedule.input.checked = sched.enabled === true
          interval.value = String(sched.intervalHours || 1)
          policy.value = cfg.conflictPolicy || 'merge-backup'
        }
        return pane
      }

      // ---------- 页签 4：记录与诊断 ----------
      function buildHistory() {
        const pane = h('div', 'wds-pane')
        const kv = h('dl', 'wds-kv')
        const lockLine = h('div', 'wds-hint', '')
        const logs = h('div', 'wds-list wds-scroll')
        const refreshBtn = button(t.history.refresh)
        const reprobeBtn = button(t.history.reprobe)
        const state = status(pane)

        refreshBtn.onclick = () => void refreshHistory()
        reprobeBtn.onclick = async () => {
          reprobeBtn.disabled = true
          try {
            const env = await api('/reprobe', { method: 'POST' })
            renderEnv(env)
            state.show('ok', t.common.ok)
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            reprobeBtn.disabled = false
          }
        }

        pane.append(
          h('div', 'wds-hint', t.history.env),
          kv,
          h('div', 'wds-actions', refreshBtn, reprobeBtn),
          lockLine,
          h('div', 'wds-hint', t.history.logs),
          logs,
        )
        pane.refreshHistory = refreshHistory

        function renderEnv(env) {
          kv.textContent = ''
          if (!env || !env.dshHome) {
            kv.appendChild(h('dt', '', t.history.env))
            kv.appendChild(h('dd', '', t.common.notFound))
            return
          }
          const rows = [
            ['dsh', env.dshVersion || '?'],
            ['profile', (env.profile || '?') + ' · ' + (env.generation || '?')],
            ['DSH_HOME', env.dshHome],
            ['profileDir', env.profileDir || '—'],
            ['skills', env.skillsDir || '—'],
          ]
          for (const [key, value] of rows) {
            kv.appendChild(h('dt', '', key))
            kv.appendChild(h('dd', '', value))
          }
        }

        async function refreshHistory() {
          try {
            const r = await api('/status')
            renderEnv(r.env)
            lockLine.textContent = t.history.lock + ': ' + (r.lock && r.lock.machineId ? r.lock.machineId : t.history.free)
            logs.textContent = ''
            const items = r.logs || []
            if (!items.length) logs.appendChild(h('div', 'wds-row', h('span', 'wds-row-name', t.history.empty)))
            for (const log of items.slice(-40).reverse()) {
              logs.appendChild(
                h(
                  'div',
                  'wds-row',
                  h('span', 'wds-badge', formatTime(log.at, locale)),
                  h('span', 'wds-row-name', log.message),
                ),
              )
            }
          } catch (err) {
            logs.textContent = ''
            logs.appendChild(h('div', 'wds-row', h('span', 'wds-row-name', t.common.error + ': ' + err.message)))
          }
        }
        return pane
      }

      // ---------- 页签 5：危险区 ----------
      function buildDanger() {
        const pane = h('div', 'wds-pane')
        const resetBtn = button(t.danger.reset, 'danger')
        const clearBtn = button(t.danger.clearRemote, 'danger')
        const state = status(pane)

        resetBtn.onclick = async () => {
          if (!window.confirm(t.danger.resetConfirm)) return
          resetBtn.disabled = true
          try {
            await api('/reset', { method: 'POST' })
            state.show('ok', t.common.ok)
            await refreshConfig()
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            resetBtn.disabled = false
          }
        }

        clearBtn.onclick = async () => {
          const answer = window.prompt(t.danger.clearConfirm)
          if (answer !== 'DELETE') return
          clearBtn.disabled = true
          try {
            const r = await api('/clear-remote', { method: 'POST' })
            state.show('ok', t.danger.deleted + ' (' + (r.removed || 0) + ')')
          } catch (err) {
            state.show('err', t.common.error + ': ' + err.message)
          } finally {
            clearBtn.disabled = false
          }
        }

        pane.append(
          h('div', 'wds-tip', t.danger.resetConfirm),
          h('div', 'wds-actions', resetBtn),
          h('div', 'wds-tip', t.danger.clearConfirm),
          h('div', 'wds-actions', clearBtn),
        )
        return pane
      }

      // ---------- 数据加载 ----------
      let current = null

      async function refreshConfig() {
        try {
          const cfg = await api('/config')
          current = cfg
          panes.connect.fill(cfg)
          panes.scope.fill(cfg)
          panes.mode.fill(cfg)
        } catch (err) {
          pill.className = 'wds-pill off'
          pill.textContent = t.common.error
          return
        }
        void refreshStatus()
      }

      async function refreshStatus() {
        try {
          const r = await api('/status')
          const configured = current && current.connection && current.connection.url
          pill.className = 'wds-pill ' + (configured ? 'on' : 'off')
          pill.textContent = configured
            ? t.state.last + ': ' + (r.lastSyncAt ? formatTime(r.lastSyncAt, locale) : t.state.never)
            : t.state.unconfigured
        } catch {
          pill.className = 'wds-pill off'
          pill.textContent = t.state.unconfigured
        }
      }

      syncBtn.onclick = async () => {
        syncBtn.disabled = true
        const label = syncBtn.textContent
        syncBtn.textContent = t.state.running
        try {
          const report = await api('/sync', { method: 'POST' })
          pill.className = 'wds-pill ' + (report.ok ? 'on' : 'off')
          pill.textContent =
            '↑ ' + (report.uploaded || []).length + ' · ↓ ' + (report.downloaded || []).length +
            ' · ! ' + (report.errors || []).length
          if (!report.ok && report.errors && report.errors.length) {
            panes.history.refreshHistory && void panes.history.refreshHistory()
          }
          if (current) current.lastSyncAt = report.finishedAt || new Date().toISOString()
        } catch (err) {
          pill.className = 'wds-pill off'
          pill.textContent = t.common.error + ': ' + err.message
        } finally {
          syncBtn.disabled = false
          syncBtn.textContent = label
        }
      }

      await refreshConfig()

      return () => {
        root.textContent = ''
      }
    }

    // ------------------------------------------------------------- React 薄壳

    function detectLocale() {
      const lang = (navigator.language || 'zh').toLowerCase()
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    function WebDavSyncPanel() {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!ref.current) return undefined
        let dispose = null
        let cancelled = false
        // mount 是异步的（先读配置）：卸载时若尚未完成，用 cancelled 兜住
        Promise.resolve(mount(ref.current, detectLocale())).then(
          (fn) => {
            if (cancelled) fn()
            else dispose = fn
          },
          (err) => {
            // 面板挂载失败不能静默：至少留下一条可诊断的记录
            console.error('[dsh-webdav-enhanced] panel mount failed', err)
          },
        )
        return () => {
          cancelled = true
          if (dispose) dispose()
        }
      }, [])
      return React.createElement('div', { ref, className: 'wds-host' })
    }

    // ------------------------------------------------------------- dsh 模块契约

    function apply(ctx) {
      const effect =
        typeof ctx.effect === 'function'
          ? (fn, label) => ctx.effect(fn, label)
          : (fn) => {
              const dispose = fn()
              return () => {
                if (typeof dispose === 'function') dispose()
              }
            }

      if (ctx.locale && typeof ctx.locale.register === 'function') {
        effect(() => ctx.locale.register(NS, LOCALE), NS + ': locale')
      }

      const slots = ctx.slots
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

      // 两处入口都注册：组合包详情页，以及该行的「配置」页。哪个版本的页面渲染哪个就用哪个。
      const targets = [
        { name: 'plugins.bundle.config', key: PKG },
        { name: 'plugins.row.config', key: PKG + '#' + ROW_ID },
      ]
      for (const target of targets) {
        effect(() => {
          const dispose = slots.inject(target.name, () =>
            slots.register({ name: target.name, key: target.key, locale: NS }, WebDavSyncPanel),
          )
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, NS + ': ' + target.name)
      }
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
