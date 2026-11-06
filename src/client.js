/*
 * WebDAV Sync 设置页前端（dsh 模块格式）。
 * 挂载点：插件 → 已安装插件 → dsh-webdav-enhanced（plugins.bundle.config slot）。
 * 布局：左侧二级导航（连接/内容/方式/记录/危险区），右侧内容区。
 * 风格：科学简约，与 dsh 原生设置一致；中英双语。
 * 零依赖：原生 DOM + fetch 调用 /api/webdav-enhanced/* API。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdav-enhanced',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const NS = 'webdav-enhanced'
    const API_BASE = '/api/webdav-enhanced'

    // ---------- i18n ----------
    const i18n = {
      zh: {
        title: 'WebDAV 同步',
        nav: { connect: '连接', scope: '同步内容', mode: '同步方式', history: '记录与诊断', danger: '危险区' },
        connect: {
          url: 'WebDAV 地址',
          username: '账号',
          password: '密码',
          test: '测试连接',
          testing: '测试中…',
          ok: '连接成功',
          fail: '连接失败',
          advanced: '高级选项',
          timeout: '超时（毫秒）',
          remoteRoot: '远端同步根目录',
          tls: '忽略 TLS 证书错误（仅内网自签）',
          saved: '已保存',
        },
        scope: {
          bundles: '插件（bundles）',
          skills: '技能（skills）',
          configs: '模型与配置（settings.yaml）',
          all: '全选',
          selected: '自定义',
          none: '不同步',
          exclude: '排除列表（逗号分隔）',
          includeKeys: '只同步这些顶层 key（逗号分隔）',
          tip: '配置默认关闭：避免密钥泄露；启用前请确认 .credentials.yaml 未被勾选。',
        },
        mode: {
          direction: '方向',
          both: '双向（推荐）',
          upload: '仅上传',
          download: '仅下载',
          schedule: '定时同步',
          interval: '每',
          hours: '小时',
          conflictPolicy: '冲突策略',
          'merge-backup': '自动合并 + 本地保留备份（推荐）',
          ask: '冲突时询问',
          'local-wins': '总是本机优先',
          'remote-wins': '总是远端优先',
          saved: '已保存',
        },
        history: {
          empty: '暂无同步记录',
          env: '环境探测',
          reprobe: '重新探测',
          logs: '最近日志',
          lock: '当前锁',
          free: '无（可同步）',
        },
        danger: {
          reset: '重置本机同步状态',
          resetConfirm: '将清空本机的同步记录与缓存，远端数据不受影响。确定？',
          clearRemote: '清空远端同步数据',
          clearConfirm: '将删除 WebDAV 上的全部同步文件（不可恢复）。输入 DELETE 确认：',
          deleted: '已清空',
        },
        common: { save: '保存', saving: '保存中…', saved: '已保存', error: '错误', confirm: '确定', cancel: '取消' },
      },
      en: {
        title: 'WebDAV Sync',
        nav: { connect: 'Connection', scope: 'Sync Content', mode: 'Sync Mode', history: 'History & Diagnostics', danger: 'Danger Zone' },
        connect: {
          url: 'WebDAV URL',
          username: 'Username',
          password: 'Password',
          test: 'Test Connection',
          testing: 'Testing…',
          ok: 'Connected',
          fail: 'Failed',
          advanced: 'Advanced',
          timeout: 'Timeout (ms)',
          remoteRoot: 'Remote sync root',
          tls: 'Ignore TLS errors (self-signed intranet only)',
          saved: 'Saved',
        },
        scope: {
          bundles: 'Plugins (bundles)',
          skills: 'Skills',
          configs: 'Models & Config (settings.yaml)',
          all: 'All',
          selected: 'Custom',
          none: 'Skip',
          exclude: 'Exclude list (comma separated)',
          includeKeys: 'Only sync these top-level keys (comma separated)',
          tip: 'Config sync is off by default to avoid leaking API keys. Double-check .credentials.yaml before enabling.',
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
          'merge-backup': 'Auto-merge + keep local backup (recommended)',
          ask: 'Ask on conflict',
          'local-wins': 'Always local wins',
          'remote-wins': 'Always remote wins',
          saved: 'Saved',
        },
        history: {
          empty: 'No sync history yet',
          env: 'Environment',
          reprobe: 'Re-probe',
          logs: 'Recent logs',
          lock: 'Current lock',
          free: 'None (ready)',
        },
        danger: {
          reset: 'Reset local sync state',
          resetConfirm: 'Clears local sync records & cache. Remote data is untouched. Continue?',
          clearRemote: 'Clear remote sync data',
          clearConfirm: 'Deletes ALL sync files on WebDAV (irreversible). Type DELETE to confirm:',
          deleted: 'Cleared',
        },
        common: { save: 'Save', saving: 'Saving…', saved: 'Saved', error: 'Error', confirm: 'OK', cancel: 'Cancel' },
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

    // ---------- API ----------
    async function api(path, opts) {
      const res = await fetch(API_BASE + path, {
        method: (opts && opts.method) || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      })
      if (!res.ok) {
        let detail = ''
        try {
          const parsed = await res.json()
          detail = parsed && parsed.error ? parsed.error : JSON.stringify(parsed)
        } catch {
          detail = await res.text()
        }
        throw new Error(detail || 'HTTP ' + res.status)
      }
      return res.json()
    }

    // ---------- styles ----------
    const css = `
    .wds-root { display: flex; min-height: 480px; font-size: 13px; }
    .wds-nav { width: 140px; border-right: 1px solid var(--border, #e5e5e5); padding: 12px 0; flex-shrink: 0; }
    .wds-nav-item { padding: 8px 16px; cursor: pointer; border-left: 2px solid transparent; color: var(--text, #333); }
    .wds-nav-item:hover { background: var(--hover, #f5f5f5); }
    .wds-nav-item.active { border-left-color: var(--primary, #4a7dff); color: var(--primary, #4a7dff); background: var(--hover, #f5f5f5); }
    .wds-main { flex: 1; padding: 16px 20px; overflow-y: auto; }
    .wds-section { display: none; }
    .wds-section.active { display: block; }
    .wds-field { margin-bottom: 12px; }
    .wds-field label { display: block; margin-bottom: 4px; color: var(--text-secondary, #666); font-size: 12px; }
    .wds-field input, .wds-field select, .wds-field textarea {
      width: 100%; padding: 6px 8px; border: 1px solid var(--border, #ddd); border-radius: 4px;
      font-size: 13px; background: var(--bg, #fff); color: var(--text, #333); box-sizing: border-box;
    }
    .wds-row { display: flex; gap: 12px; }
    .wds-row > * { flex: 1; }
    .wds-actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; }
    .wds-btn { padding: 6px 16px; border-radius: 4px; border: 1px solid var(--border, #ddd); cursor: pointer; background: var(--bg, #fff); color: var(--text, #333); }
    .wds-btn.primary { background: var(--primary, #4a7dff); color: #fff; border-color: var(--primary, #4a7dff); }
    .wds-btn.danger { color: var(--danger, #d43f3a); border-color: var(--danger, #d43f3a); }
    .wds-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .wds-status { padding: 8px 12px; border-radius: 4px; margin-top: 12px; display: none; }
    .wds-status.ok { display: block; background: #e6f7e6; color: #2e7d32; border: 1px solid #a5d6a7; }
    .wds-status.err { display: block; background: #fdecea; color: #c62828; border: 1px solid #ef9a9a; }
    .wds-tip { padding: 8px 12px; background: #fff8e1; border: 1px solid #ffe082; border-radius: 4px; color: #8d6e63; font-size: 12px; margin-bottom: 12px; }
    .wds-check { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .wds-check input[type=checkbox] { width: auto; }
    .wds-list { border: 1px solid var(--border, #eee); border-radius: 4px; max-height: 240px; overflow-y: auto; }
    .wds-list-item { padding: 8px 12px; border-bottom: 1px solid var(--border, #f0f0f0); display: flex; align-items: center; gap: 8px; }
    .wds-list-item:last-child { border-bottom: none; }
    .wds-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: var(--hover, #eee); color: var(--text-secondary, #888); }
    .wds-badge.remote { background: #e3f2fd; color: #1565c0; }
    .wds-badge.conflict { background: #ffebee; color: #c62828; }
    .wds-tabs-mini { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border, #eee); }
    .wds-tab-mini { padding: 6px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
    .wds-tab-mini.active { border-bottom-color: var(--primary, #4a7dff); color: var(--primary, #4a7dff); }
    .wds-sub { display: none; }
    .wds-sub.active { display: block; }
  `

    // ---------- mount ----------
    /** 挂载设置页到给定容器，返回清理函数（供 React 卸载时调用） */
    function mount(root, locale) {
      const t = i18n[locale] || i18n.zh
      root.innerHTML = ''
      const style = document.createElement('style')
      style.textContent = css
      root.appendChild(style)

      const wrap = el('div', 'wds-root')
      const nav = el('div', 'wds-nav')
      const main = el('div', 'wds-main')

      const sections = ['connect', 'scope', 'mode', 'history', 'danger']
      for (const key of sections) {
        const item = el('div', 'wds-nav-item', t.nav[key])
        item.dataset.section = key
        item.onclick = () => activate(key)
        nav.appendChild(item)
      }

      const secConnect = buildConnect(t)
      const secScope = buildScope(t)
      const secMode = buildMode(t)
      const secHistory = buildHistory(t)
      const secDanger = buildDanger(t)

      main.append(secConnect, secScope, secMode, secHistory, secDanger)
      wrap.append(nav, main)
      root.appendChild(wrap)

      function activate(key) {
        for (const item of nav.children) item.classList.toggle('active', item.dataset.section === key)
        for (const sec of main.children) sec.classList.toggle('active', sec.dataset.section === key)
        if (key === 'history' && secHistory.refreshHistory) secHistory.refreshHistory()
      }
      secConnect.dataset.section = 'connect'
      secScope.dataset.section = 'scope'
      secMode.dataset.section = 'mode'
      secHistory.dataset.section = 'history'
      secDanger.dataset.section = 'danger'
      activate('connect')

      return () => {
        root.innerHTML = ''
      }
    }

    function el(tag, cls, text) {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }

    function field(labelText, inputEl) {
      const f = el('div', 'wds-field')
      const l = el('label', '', labelText)
      f.append(l, inputEl)
      return f
    }

    function input(type, placeholder, value) {
      const i = document.createElement('input')
      i.type = type
      if (placeholder) i.placeholder = placeholder
      if (value !== undefined) i.value = value
      return i
    }

    function select(options, value) {
      const s = document.createElement('select')
      for (const [v, label] of options) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = label
        s.appendChild(o)
      }
      if (value) s.value = value
      return s
    }

    function btn(text, primary) {
      const b = el('button', 'wds-btn' + (primary ? ' primary' : ''), text)
      b.type = 'button'
      return b
    }

    function statusBox(cls, text) {
      return el('div', 'wds-status ' + cls, text)
    }

    // ---------- sections ----------
    function buildConnect(t) {
      const sec = el('div', 'wds-section')
      const h = el('h3', '', t.nav.connect)
      h.style.marginTop = '0'

      const url = input('text', 'https://dav.example.com/dsh/', '')
      const user = input('text', '', '')
      const pass = input('password', '', '')
      const testBtn = btn(t.connect.test, true)
      const saveBtn = btn(t.common.save)
      const status = statusBox('ok', '')
      status.style.display = 'none'

      testBtn.onclick = async () => {
        testBtn.disabled = true
        testBtn.textContent = t.connect.testing
        status.style.display = 'none'
        try {
          const r = await api('/test', {
            method: 'POST',
            body: { url: url.value, username: user.value, password: pass.value },
          })
          if (r.ok) {
            status.className = 'wds-status ok'
            status.textContent = t.connect.ok + ' — ' + r.steps.map((s) => `${s.step}:${s.ok ? '✓' : '✗'}`).join(' ')
          } else {
            status.className = 'wds-status err'
            status.textContent = t.connect.fail + ' — ' + r.steps.map((s) => `${s.step}:${s.ok ? '✓' : '✗'} ${s.detail}`).join('; ')
          }
        } catch (e) {
          status.className = 'wds-status err'
          status.textContent = t.common.error + ': ' + e.message
        } finally {
          testBtn.disabled = false
          testBtn.textContent = t.connect.test
        }
      }

      saveBtn.onclick = async () => {
        saveBtn.disabled = true
        try {
          await api('/config', {
            method: 'POST',
            body: { connection: { url: url.value, username: user.value, password: pass.value, passwordRef: 'credentials' } },
          })
          status.className = 'wds-status ok'
          status.textContent = t.connect.saved
        } catch (e) {
          status.className = 'wds-status err'
          status.textContent = e.message
        } finally {
          saveBtn.disabled = false
        }
      }

      // advanced (collapsed by default)
      const advToggle = el('div', 'wds-tip', '▸ ' + t.connect.advanced)
      advToggle.style.cursor = 'pointer'
      const adv = el('div')
      adv.style.display = 'none'
      advToggle.onclick = () => {
        adv.style.display = adv.style.display === 'none' ? 'block' : 'none'
        advToggle.textContent = (adv.style.display === 'none' ? '▸ ' : '▾ ') + t.connect.advanced
      }
      const timeout = input('number', '30000', 30000)
      const rootDir = input('text', '/dsh-sync/', '/dsh-sync/')
      const tls = document.createElement('input')
      tls.type = 'checkbox'
      const tlsWrap = el('label', 'wds-check')
      tlsWrap.append(tls, document.createTextNode(t.connect.tls))
      adv.append(field(t.connect.timeout, timeout), field(t.connect.remoteRoot, rootDir), tlsWrap)

      sec.append(h, field(t.connect.url, url), field(t.connect.username, user), field(t.connect.password, pass), advToggle, adv, el('div', 'wds-actions', testBtn), el('div', 'wds-actions', saveBtn), status)
      return sec
    }

    function buildScope(t) {
      const sec = el('div', 'wds-section')
      const h = el('h3', '', t.nav.scope)
      h.style.marginTop = '0'
      sec.appendChild(h)

      const groups = [
        { key: 'bundles', label: t.scope.bundles },
        { key: 'skills', label: t.scope.skills },
        { key: 'configs', label: t.scope.configs },
      ]
      const state = { bundles: { mode: 'all', exclude: [] }, skills: { mode: 'all', exclude: [] }, configs: { mode: 'none', includeKeys: [] } }

      for (const g of groups) {
        const box = el('div', '')
        box.style.marginBottom = '16px'
        const title = el('div', '', g.label)
        title.style.fontWeight = '600'
        title.style.marginBottom = '6px'
        const modeSel = select(
          [
            ['all', t.scope.all],
            ['selected', t.scope.selected],
            ['none', t.scope.none],
          ],
          state[g.key].mode,
        )
        const listWrap = el('div', 'wds-list')
        const renderList = async () => {
          listWrap.innerHTML = ''
          if (state[g.key].mode !== 'selected') return
          try {
            const items = await api('/items?kind=' + g.key)
            const excludes = new Set(state[g.key].exclude)
            for (const it of items) {
              const row = el('div', 'wds-list-item')
              const cb = document.createElement('input')
              cb.type = 'checkbox'
              cb.checked = !excludes.has(it.name)
              cb.onchange = () => {
                const set = new Set(state[g.key].exclude)
                if (cb.checked) set.delete(it.name)
                else set.add(it.name)
                state[g.key].exclude = [...set]
              }
              const name = el('span', '', it.name)
              const badge = el('span', 'wds-badge', it.version || it.kind)
              row.append(cb, name, badge)
              listWrap.appendChild(row)
            }
            if (items.length === 0) listWrap.appendChild(el('div', 'wds-list-item', '—'))
          } catch (e) {
            listWrap.appendChild(el('div', 'wds-list-item', t.common.error + ': ' + e.message))
          }
        }
        modeSel.onchange = () => {
          state[g.key].mode = modeSel.value
          renderList()
        }
        box.append(title, field('', modeSel))
        box.appendChild(listWrap)

        const exclInput = input('text', '', '')
        exclInput.onchange = () => {
          state[g.key].exclude = exclInput.value.split(',').map((s) => s.trim()).filter(Boolean)
        }
        if (g.key === 'configs') {
          box.appendChild(field(t.scope.includeKeys, exclInput))
          box.appendChild(el('div', 'wds-tip', t.scope.tip))
        } else {
          box.appendChild(field(t.scope.exclude, exclInput))
        }

        sec.appendChild(box)
      }

      const saveBtn = btn(t.common.save, true)
      const status = statusBox('ok', '')
      status.style.display = 'none'
      saveBtn.onclick = async () => {
        saveBtn.disabled = true
        try {
          await api('/config', { method: 'POST', body: { scope: state } })
          status.className = 'wds-status ok'
          status.textContent = t.common.saved
        } catch (e) {
          status.className = 'wds-status err'
          status.textContent = e.message
        } finally {
          saveBtn.disabled = false
        }
      }
      sec.appendChild(el('div', 'wds-actions', saveBtn))
      sec.appendChild(status)
      return sec
    }

    function buildMode(t) {
      const sec = el('div', 'wds-section')
      const h = el('h3', '', t.nav.mode)
      h.style.marginTop = '0'

      const dirSel = select(
        [
          ['both', t.mode.both],
          ['upload', t.mode.upload],
          ['download', t.mode.download],
        ],
        'both',
      )
      const schedChk = document.createElement('input')
      schedChk.type = 'checkbox'
      const interval = input('number', '1', 1)
      interval.min = '0.5'
      interval.step = '0.5'
      const policySel = select(
        [
          ['merge-backup', t.mode['merge-backup']],
          ['ask', t.mode.ask],
          ['local-wins', t.mode['local-wins']],
          ['remote-wins', t.mode['remote-wins']],
        ],
        'merge-backup',
      )

      const saveBtn = btn(t.common.save, true)
      const status = statusBox('ok', '')
      status.style.display = 'none'
      saveBtn.onclick = async () => {
        saveBtn.disabled = true
        try {
          await api('/config', {
            method: 'POST',
            body: {
              schedule: { enabled: schedChk.checked, intervalHours: parseFloat(interval.value) || 1, direction: dirSel.value },
              conflictPolicy: policySel.value,
            },
          })
          status.className = 'wds-status ok'
          status.textContent = t.mode.saved
        } catch (e) {
          status.className = 'wds-status err'
          status.textContent = e.message
        } finally {
          saveBtn.disabled = false
        }
      }

      const schedWrap = el('label', 'wds-check')
      schedWrap.append(schedChk, document.createTextNode(t.mode.schedule))
      const row = el('div', 'wds-row')
      row.append(field(t.mode.interval, interval), el('div', 'wds-field', el('label', '', t.mode.hours)))
      row.style.alignItems = 'flex-end'

      sec.append(
        h,
        field(t.mode.direction, dirSel),
        schedWrap,
        row,
        field(t.mode.conflictPolicy, policySel),
        el('div', 'wds-actions', saveBtn),
        status,
      )
      return sec
    }

    function buildHistory(t) {
      const sec = el('div', 'wds-section')
      const h = el('h3', '', t.nav.history)
      h.style.marginTop = '0'

      const envBox = el('div', 'wds-tip', t.history.env + ': …')
      const reprobe = btn(t.history.reprobe)
      function renderEnv(env) {
        if (!env || !env.dshHome) {
          envBox.textContent = t.history.env + ': not found'
          return
        }
        envBox.textContent = `${t.history.env}: ${env.dshHome} (${env.generation}, dsh ${env.dshVersion || '?'})`
      }
      reprobe.onclick = async () => {
        reprobe.disabled = true
        try {
          const r = await api('/reprobe', { method: 'POST' })
          renderEnv(r)
        } catch (e) {
          envBox.textContent = t.common.error + ': ' + e.message
        } finally {
          reprobe.disabled = false
        }
      }

      const lockBox = el('div', '', t.history.lock + ': ' + t.history.free)
      const logList = el('div', 'wds-list')

      sec.append(h, envBox, el('div', 'wds-actions', reprobe), lockBox, el('div'), logList)

      async function refreshHistory() {
        try {
          const r = await api('/status')
          renderEnv(r.env)
          lockBox.textContent = `${t.history.lock}: ${r.lock ? r.lock.machineId : t.history.free}`
          logList.innerHTML = ''
          const logs = r.logs || []
          if (logs.length === 0) {
            logList.appendChild(el('div', 'wds-list-item', t.history.empty))
          } else {
            for (const log of logs.slice(-20).reverse()) {
              const row = el('div', 'wds-list-item')
              const time = el('span', 'wds-badge', new Date(log.at).toLocaleTimeString())
              const msg = el('span', '', log.message)
              row.append(time, msg)
              logList.appendChild(row)
            }
          }
        } catch (e) {
          logList.innerHTML = ''
          logList.appendChild(el('div', 'wds-list-item', t.common.error + ': ' + e.message))
        }
      }
      sec.refreshHistory = refreshHistory
      return sec
    }

    function buildDanger(t) {
      const sec = el('div', 'wds-section')
      const h = el('h3', '', t.nav.danger)
      h.style.marginTop = '0'

      const resetBtn = btn(t.danger.reset)
      resetBtn.classList.add('danger')
      resetBtn.onclick = async () => {
        if (!confirm(t.danger.resetConfirm)) return
        try {
          await api('/reset', { method: 'POST' })
          alert(t.danger.reset + ' ✓')
        } catch (e) {
          alert(t.common.error + ': ' + e.message)
        }
      }

      const clearBtn = btn(t.danger.clearRemote)
      clearBtn.classList.add('danger')
      clearBtn.onclick = async () => {
        const v = prompt(t.danger.clearConfirm)
        if (v !== 'DELETE') return
        try {
          await api('/clear-remote', { method: 'POST' })
          alert(t.danger.deleted)
        } catch (e) {
          alert(t.common.error + ': ' + e.message)
        }
      }

      sec.append(h, el('div', 'wds-actions', resetBtn), el('div', 'wds-actions', clearBtn))
      return sec
    }

    // ---------- React 薄壳 ----------
    function detectLocale() {
      const lang = (navigator.language || 'zh').toLowerCase()
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    function WebDavSyncPanel() {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!ref.current) return undefined
        return mount(ref.current, detectLocale())
      }, [])
      return React.createElement('div', { ref, className: 'wds-host' })
    }

    // ---------- dsh 模块契约 ----------
    const dictZh = flattenDict(i18n.zh)
    const dictEn = flattenDict(i18n.en)

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: dictZh, en: dictEn }), 'webdav-enhanced: dictionaries')
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-webdav-enhanced',
            locale: NS,
          },
          WebDavSyncPanel,
        ),
      )
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
