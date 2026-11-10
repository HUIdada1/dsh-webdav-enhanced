/*
 * WebDAV Sync —— dsh 插件配置面板（浏览器半侧，dsh 模块格式）。
 *
 * 挂载点（三处，同一套面板，两种外壳）：
 *   1. plugins.bundle.config —— 插件 → 已安装插件 → dsh-webdav-enhanced 详情页
 *   2. plugins.row.config    —— 同一详情页里该行多出的「配置」入口
 *   3. settings.section      —— 设置弹窗左侧导航里的独立设置页（id: webdav-sync）
 * 插槽只有在对应页面打开时才存在，因此一律用 ctx.slots.inject 等待，不要假设已就绪。
 *
 * 设计约束（踩过的坑，勿回退）：
 *   - DOM 构造一律走 h(tag, cls, ...children)，children 可以是字符串 / 节点 / 数组；
 *     旧实现把节点当文本传，按钮全变成 "[object HTMLButtonElement]"。
 *   - 颜色只用 --dsw-alias-* 设计令牌（带回退），浅色/深色主题都不写死色值。
 *   - 零依赖：不 import 任何模块，只 require('react')。
 *   - 进度轮询与日志刷新必须在卸载时清干净，否则设置弹窗反复开关会堆定时器。
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
    /** 运行中轮询间隔（毫秒） */
    const POLL_MS = 900
    /** 日志一次最多渲染多少条（再多也只保留尾部） */
    const LOG_RENDER_LIMIT = 300

    // ---------------------------------------------------------------- i18n

    const i18n = {
      zh: {
        meta: {
          title: 'WebDAV 同步',
          subtitle: '用一台 WebDAV 服务器，把插件、技能与模型配置在机器之间自动对齐',
          settingsNote: '此页面与插件详情页共享同一份配置与运行状态',
        },
        nav: {
          overview: '概览',
          guide: '说明',
          connect: '连接',
          scope: '内容',
          mode: '方式',
          logs: '日志',
          diag: '诊断',
          settingsTitle: 'WebDAV 同步',
        },
        state: {
          unconfigured: '未配置',
          ready: '已就绪',
          running: '同步中',
          failed: '上次失败',
          never: '从未同步',
        },
        action: {
          syncNow: '立即同步',
          cancel: '取消同步',
          save: '保存',
          saved: '已保存',
          test: '测试连接',
          testing: '测试中…',
          refresh: '刷新',
          analyze: '分析差异',
          analyzing: '分析中…',
          export: '导出',
          copy: '复制',
          copied: '已复制',
          retry: '重试',
          more: '高级选项',
          reprobe: '重新探测',
          reset: '重置本机状态',
          clearRemote: '清空远端数据',
        },
        overview: {
          tileLast: '上次同步',
          tileMachine: '本机标识',
          tileDirection: '同步方向',
          tileSchedule: '定时同步',
          directionBoth: '双向',
          directionUpload: '仅上传',
          directionDownload: '仅下载',
          scheduleOff: '未开启',
          scheduleEvery: '每 {n} 小时',
          runTitle: '同步进度',
          runIdle: '当前没有正在运行的同步',
          runIdleHint: '点「立即同步」按当前策略跑一次，或到「方式」页开启定时。',
          phase: '阶段',
          current: '当前条目',
          elapsed: '已用时',
          resultTitle: '上次运行结果',
          resultEmpty: '还没有运行记录。第一次同步完成后，这里会列出每个条目的处理结果。',
          resultAt: '{time} · 触发：{trigger} · 用时 {duration}',
          triggerManual: '手动',
          triggerScheduled: '定时',
          triggerAuto: '自动',
          itemsTitle: '条目明细',
          moreItems: '另有 {n} 条未展开',
          failedTitle: '失败明细',
          analyzeTitle: '分析差异（不写入任何数据）',
          analyzeDesc: '先扫描本机、再读远端清单，算出每个条目该上传、下载、合并还是跳过。分析不会改动本机与远端。',
          analyzeEmpty: '点「分析差异」查看下一次同步会做什么。',
          analyzeRunning: '正在分析…',
          analyzeSummary: '共 {total} 个条目：上传 {upload} · 下载 {download} · 合并 {merge} · 跳过 {skip} · 删除 {remove}',
          analyzeAt: '分析于 {time}',
          restartNeeded: '有 {n} 项需要重启 dsh 才生效：{list}',
        },
        guide: {
          lead: '一台机器配好，其余机器自动跟上。不用再重复安装插件、手工拷贝配置，也不用为了对齐环境折腾一晚上。',
          chip1: '内容哈希去重',
          chip2: '自动合并',
          chip3: '实时进度',
          quickTitle: '三步上手',
          quick1Title: '连接服务器',
          quick1Desc: '在「连接」页填地址、账号、密码，点「测试连接」。测试会依次验证读取、建目录、写入与回读，通过后自动保存。',
          quick2Title: '选择同步内容',
          quick2Desc: '在「内容」页勾选要同步的插件、技能与模型配置。默认插件 + 技能全同步，模型配置默认关闭（settings.yaml 可能含密钥）。',
          quick3Title: '确认策略',
          quick3Desc: '在「方式」页选方向、定时与智能选项。默认双向 + 自动合并，之后可以完全不管它。',
          quick4Title: '随时看进度',
          quick4Desc: '同步时「概览」页实时显示阶段、百分比、当前条目与各类计数；跑完在「日志」页按成功、失败、合并筛选。',
          featTitle: '能同步什么',
          feat1Title: '插件',
          feat1Desc: 'profile 里声明为 bundle 的依赖按本地路径打包上传，其他机器下载后自动安装，装好提示重启 dsh。',
          feat2Title: '技能',
          feat2Desc: '$DSH_HOME/skills 下每个含 SKILL.md 的目录整包同步，装一次到处可用。',
          feat3Title: '模型与配置',
          feat3Desc: 'settings.yaml 的顶层 key 按需同步，按键合并而不是整文件覆盖；apiKey 等敏感 key 永不参与。',
          feat4Title: '运行观察',
          feat4Desc: '实时进度、分类日志、干跑分析三件套：同步前后都能看清每一步做了什么。',
          rulesTitle: '同步规则',
          ruleUpload: '上传',
          ruleUploadDesc: '本机有、远端没有，或只有本机改过：上传一次。内容哈希相同的文件不会重复上传。',
          ruleDownload: '下载',
          ruleDownloadDesc: '远端有、本机没有，或只有远端改过：下载并自动安装，旧版本先备份。',
          ruleMerge: '自动合并',
          ruleMergeDesc: '两端都改过：先比修改时间、再比版本号自动选赢家，输家自动备份，不需要你来决策。',
          ruleSkip: '跳过',
          ruleSkipDesc: '两端内容一致，不做任何传输。',
          ruleDelete: '删除传播',
          ruleDeleteDesc: '一端删除，另一端跟随删除：远端文件进回收站，本地先打包备份，随时可恢复。',
          compatTitle: '服务器兼容',
          compatServer: '服务',
          compatNote: '说明',
          compat1: 'Nextcloud / ownCloud',
          compat1Desc: '完整支持，建议使用应用专用密码',
          compat2: '坚果云',
          compat2Desc: '可用；需开启 WebDAV 并使用应用密码，有频率限制，间隔建议 ≥ 1 小时',
          compat3: '群晖 Synology',
          compat3Desc: '安装 WebDAV Server 套件后完整支持',
          compat4: 'AList',
          compat4Desc: '完整支持，任意存储驱动',
          compat5: '自建服务',
          compat5Desc: '任意 RFC 4918 实现；不支持 LOCK / If-Match 时自动降级为软锁与冲突副本',
          securityTitle: '安全边界',
          sec1Title: '密码不出本机',
          sec1Desc: 'WebDAV 密码只写在本机凭据文件（权限 0600），不进配置、不上远端，接口返回里永远没有密码。',
          sec2Title: '配置默认不同步',
          sec2Desc: 'settings.yaml 可能含 API Key，所以默认关闭；要同步就用「只同步这些顶层 key」精确指定。',
          sec3Title: '解压有护栏',
          sec3Desc: '拒绝路径穿越与 zip 炸弹，单文件与总量都有上限；所有 zip 按内容哈希校验后再落盘。',
          faqTitle: '常见问题',
          faq1q: '同步完成后插件没生效？',
          faq1a: '插件（bundle）需要 dsh 重启才会加载。模式设为自动安装时，页面会提示「待重启」；重启后即生效。技能类条目新开一次对话即可看到。',
          faq2q: '旧版本备份到哪里了？',
          faq2a: '自动合并、下载覆盖、删除传播都会先备份：$DSH_HOME/.webdav-enhanced/backups/ 下按 bundles 与 skills 分目录，保留份数由「备份保留份数」控制。',
          faq3q: '日志在哪里？',
          faq3a: '界面上是「日志」页，磁盘上是 $DSH_HOME/.webdav-enhanced/logs/sync.jsonl（超过 1MB 自动轮转一份）。可以直接把文件发给别人排查。',
          faq4q: '自动合并会不会丢数据？',
          faq4a: '不会。裁决出的输家一定先打包备份，远端删除只进回收站；两次同步之间留足备份份数即可回滚。',
          faq5q: '两台机器同时同步会打架吗？',
          faq5a: '服务端支持 LOCK 时用原生锁，否则用软锁 + 清单条件写：后到的一方会发现清单已变并重读重合并，最多重试 3 次。同一台机器内部还有运行互斥。',
          faq6q: '坚果云报 503 或很慢？',
          faq6a: '坚果云对 WebDAV 有频率限制。把定时间隔调大（≥ 1 小时），并把大文件目录加进排除列表。',
          aboutTitle: '关于',
          aboutVersion: '版本',
          aboutMachine: '机器 ID',
          aboutDataDir: '本机数据目录',
          aboutRemote: '远端根目录',
          aboutProfile: 'profile',
          aboutDocs: '完整文档见包内 README.md',
        },
        connect: {
          url: 'WebDAV 地址',
          urlHint: '例如 https://dav.example.com/dsh/',
          username: '账号',
          password: '密码',
          passwordHint: '留空表示不修改已保存的密码',
          hasPassword: '已保存密码',
          noPassword: '尚未保存密码',
          advanced: '高级选项',
          timeout: '单次请求超时（毫秒）',
          remoteRoot: '远端同步根目录',
          tls: '忽略 TLS 证书错误',
          tlsHint: '仅内网自签证书场景开启',
          ok: '连接成功',
          fail: '连接失败',
          server: '服务端',
          caps: '能力',
          capsLock: '原生 LOCK',
          capsIf: 'If-Match',
          capsYes: '支持',
          capsNo: '不支持',
          steps: '步骤',
          stepPropfind: '读取目录',
          stepMkcol: '建目录',
          stepPut: '写入',
          stepReadback: '回读',
          http401: '认证失败：账号或密码不正确。坚果云 / Nextcloud 请用应用专用密码；改过密码的话在密码框重新输入并保存。',
          http403: '没有写权限：账号只读，或该目录被限制。',
          http404: '目标不存在：地址可能少了一层路径。',
          http405: '服务端不允许这个操作（部分服务端禁用 MKCOL）。',
          http409: '父目录不存在，或路径冲突。',
          http423: '远端被锁定：多为上一次测试/同步残留的 LOCK，等 10–60 秒或解除后重试。',
          http507: '远端空间不足。',
        },
        scope: {
          bundles: '插件',
          skills: '技能',
          configs: '模型与配置',
          all: '全部',
          selected: '仅勾选',
          none: '不同步',
          exclude: '排除的条目名',
          includeKeys: '只同步这些顶层 key',
          chipHint: '回车或逗号分隔，右侧是可移除的标签',
          addChip: '输入后回车添加',
          empty: '没有扫描到条目',
          loading: '正在扫描…',
          configsTip: '配置里可能有 API Key：默认关闭，敏感顶层 key（apiKey / token / secret 等）无论怎么勾都不会同步。',
          save: '保存同步内容',
          selectedCount: '已选 {n} / {total}',
        },
        mode: {
          direction: '同步方向',
          both: '双向',
          upload: '仅上传',
          download: '仅下载',
          directionHint: '双向会在两端互相同步；单向只推送或只拉取。',
          schedule: '定时同步',
          scheduleHint: '开启后按间隔自动跑一次，带 0–5 分钟随机抖动，避免多机撞锁。',
          interval: '间隔（小时）',
          conflictPolicy: '分叉处理策略',
          policyAuto: '自动裁决（推荐）',
          policyAutoHint: '按修改时间 → 版本号选赢家，输家自动备份，不需要人工决策。',
          policyMergeBackup: '远端优先并保留备份',
          policyAsk: '标记为冲突、等我处理',
          policyLocal: '总是本机优先',
          policyRemote: '总是远端优先',
          smartTitle: '智能选项',
          propagate: '删除传播',
          propagateHint: '一端删除，另一端跟随删除（远端进回收站，本地先备份）',
          dedupe: '跨条目去重',
          dedupeHint: '远端已有同内容文件时只登记清单，不重复上传',
          autoInstall: '下载后自动安装',
          autoInstallHint: '关闭后只下载不落盘，留给你手工处理',
          contentMerge: '配置按键合并',
          contentMergeHint: 'settings.yaml 按顶层 key 合并，不整文件覆盖',
          prune: '同步后清理',
          pruneHint: '清理远端墓碑与超过 7 天的回收站文件',
          maxBackups: '备份保留份数',
          save: '保存同步方式',
        },
        logs: {
          title: '运行日志',
          filterAll: '全部',
          filterOk: '成功',
          filterFail: '失败',
          filterMerge: '合并',
          filterSkip: '跳过',
          filterDelete: '删除',
          search: '搜索条目名或内容…',
          autoRefresh: '运行中自动刷新',
          empty: '还没有日志。同步一次后这里会按分类列出每一步。',
          noMatch: '没有匹配的日志',
          notSupported: '当前后端还没有日志接口，重启 dsh 后即可使用。',
          exportDone: '已复制到剪贴板',
          exportFail: '复制失败，请手动从日志文件读取',
          showing: '显示 {n} 条',
        },
        diag: {
          envTitle: '环境探测',
          dsh: 'dsh 版本',
          profile: 'profile',
          home: '数据目录',
          profileDir: 'profile 目录',
          skillsDir: '技能目录',
          settings: 'settings.yaml',
          generation: '宿主代际',
          lockTitle: '同步锁',
          lockFree: '无（可以同步）',
          lockHeld: '{machine} 持有，至 {time}',
          capsTitle: '服务端能力',
          dangerTitle: '危险区',
          resetTitle: '重置本机同步状态',
          resetDesc: '清空本机的同步记录与凭据，远端数据不受影响。',
          resetConfirm: '确定重置？本机凭据与同步记录将被清空。',
          resetArmed: '再点一次确认重置',
          clearTitle: '清空远端同步数据',
          clearDesc: '删除远端全部同步文件，不可恢复。请输入 DELETE 确认。',
          clearPlaceholder: '输入 DELETE',
          notFound: '未探测到',
        },
        item: {
          upload: '上传',
          download: '下载',
          merge: '合并',
          skip: '跳过',
          deleteLocal: '删本地',
          deleteRemote: '删远端',
          conflict: '冲突',
        },
        status: {
          pending: '待处理',
          running: '进行中',
          ok: '成功',
          failed: '失败',
          skipped: '跳过',
          merged: '已合并',
          deleted: '已删除',
          conflict: '冲突',
        },
        phase: {
          idle: '空闲',
          scan: '扫描本机',
          manifest: '读取远端清单',
          plan: '计算差异',
          download: '下载并安装',
          upload: '上传本机内容',
          prune: '清理远端垃圾',
          finalize: '收尾',
          done: '完成',
          error: '出错',
          cancelled: '已取消',
        },
        cat: {
          sync: '同步',
          upload: '上传',
          download: '下载',
          merge: '合并',
          conflict: '冲突',
          skip: '跳过',
          delete: '删除',
          dedupe: '去重',
          connection: '连接',
          schedule: '定时',
          env: '环境',
          system: '系统',
          prune: '清理',
        },
        level: {
          info: '信息',
          success: '成功',
          warn: '警告',
          error: '错误',
        },
        common: {
          error: '错误',
          loading: '加载中…',
          empty: '暂无数据',
          close: '关闭',
          cancel: '取消',
          confirm: '确认',
          yes: '是',
          no: '否',
          unknown: '未知',
          bytes: 'B',
          seconds: '秒',
          minutes: '分',
        },
      },
      en: {
        meta: {
          title: 'WebDAV sync',
          subtitle: 'Keep plugins, skills and model config aligned across machines through one WebDAV server',
          settingsNote: 'This page shares the same configuration and run state as the plugin detail page',
        },
        nav: {
          overview: 'Overview',
          guide: 'Guide',
          connect: 'Connection',
          scope: 'Content',
          mode: 'Mode',
          logs: 'Logs',
          diag: 'Diagnostics',
          settingsTitle: 'WebDAV sync',
        },
        state: {
          unconfigured: 'Not configured',
          ready: 'Ready',
          running: 'Syncing',
          failed: 'Last run failed',
          never: 'Never synced',
        },
        action: {
          syncNow: 'Sync now',
          cancel: 'Cancel sync',
          save: 'Save',
          saved: 'Saved',
          test: 'Test connection',
          testing: 'Testing…',
          refresh: 'Refresh',
          analyze: 'Analyze changes',
          analyzing: 'Analyzing…',
          export: 'Export',
          copy: 'Copy',
          copied: 'Copied',
          retry: 'Retry',
          more: 'Advanced',
          reprobe: 'Re-probe',
          reset: 'Reset local state',
          clearRemote: 'Clear remote data',
        },
        overview: {
          tileLast: 'Last sync',
          tileMachine: 'Machine',
          tileDirection: 'Direction',
          tileSchedule: 'Schedule',
          directionBoth: 'Two-way',
          directionUpload: 'Upload only',
          directionDownload: 'Download only',
          scheduleOff: 'Off',
          scheduleEvery: 'Every {n}h',
          runTitle: 'Progress',
          runIdle: 'No sync is running',
          runIdleHint: 'Run one now, or turn on the schedule on the Mode tab.',
          phase: 'Phase',
          current: 'Current item',
          elapsed: 'Elapsed',
          resultTitle: 'Last run',
          resultEmpty: 'No runs yet. After the first sync this lists what happened to each item.',
          resultAt: '{time} · trigger: {trigger} · took {duration}',
          triggerManual: 'manual',
          triggerScheduled: 'scheduled',
          triggerAuto: 'automatic',
          itemsTitle: 'Items',
          moreItems: '{n} more not shown',
          failedTitle: 'Failures',
          analyzeTitle: 'Analyze changes (writes nothing)',
          analyzeDesc: 'Scans this machine, reads the remote manifest, and decides upload / download / merge / skip per item. Nothing is written.',
          analyzeEmpty: 'Run the analysis to preview what the next sync would do.',
          analyzeRunning: 'Analyzing…',
          analyzeSummary: '{total} items: upload {upload} · download {download} · merge {merge} · skip {skip} · remove {remove}',
          analyzeAt: 'Analyzed at {time}',
          restartNeeded: '{n} item(s) need a dsh restart to take effect: {list}',
        },
        guide: {
          lead: 'Set it up once and the other machines catch up on their own — no reinstalling plugins or hand-copying config.',
          chip1: 'Content-addressed dedupe',
          chip2: 'Automatic merge',
          chip3: 'Live progress',
          quickTitle: 'Three steps',
          quick1Title: 'Connect the server',
          quick1Desc: 'On the Connection tab fill the URL, account and password, then test. The test checks read, mkdir, write and read-back, and saves on success.',
          quick2Title: 'Pick what to sync',
          quick2Desc: 'On Content, choose plugins, skills and model config. Plugins and skills sync by default; config stays off because settings.yaml may hold API keys.',
          quick3Title: 'Confirm the strategy',
          quick3Desc: 'On Mode, pick direction, schedule and smart options. Two-way plus automatic merge is the default, and then you can forget about it.',
          quick4Title: 'Watch it run',
          quick4Desc: 'The Overview tab shows phase, percentage, current item and counts live; Logs filters by success, failure and merge.',
          featTitle: 'What gets synced',
          feat1Title: 'Plugins',
          feat1Desc: 'Bundles declared in the profile are packed and uploaded; other machines download and install them, then ask for a restart.',
          feat2Title: 'Skills',
          feat2Desc: 'Every directory under $DSH_HOME/skills that has a SKILL.md is synced whole — install once, available everywhere.',
          feat3Title: 'Models & config',
          feat3Desc: 'Top-level keys of settings.yaml sync on demand and merge per key; apiKey and other secrets never take part.',
          feat4Title: 'Observability',
          feat4Desc: 'Live progress, categorized logs and a dry-run analysis: you can see each step before and after a sync.',
          rulesTitle: 'Sync rules',
          ruleUpload: 'Upload',
          ruleUploadDesc: 'Present here, missing remotely, or only changed here: upload once. Identical content is never re-uploaded.',
          ruleDownload: 'Download',
          ruleDownloadDesc: 'Present remotely, missing here, or only changed remotely: download, install, and back up the old version first.',
          ruleMerge: 'Automatic merge',
          ruleMergeDesc: 'Changed on both sides: newer mtime, then higher version wins, and the loser is backed up — no decision needed from you.',
          ruleSkip: 'Skip',
          ruleSkipDesc: 'Both sides are identical; nothing is transferred.',
          ruleDelete: 'Deletion propagation',
          ruleDeleteDesc: 'A deletion on one side follows to the other: remote files go to trash, local copies are packed first.',
          compatTitle: 'Server compatibility',
          compatServer: 'Server',
          compatNote: 'Notes',
          compat1: 'Nextcloud / ownCloud',
          compat1Desc: 'Fully supported; use an app password',
          compat2: 'Nutstore',
          compat2Desc: 'Works with WebDAV enabled and an app password; rate limited, so keep the interval at 1h or more',
          compat3: 'Synology',
          compat3Desc: 'Fully supported with the WebDAV Server package',
          compat4: 'AList',
          compat4Desc: 'Fully supported on any storage driver',
          compat5: 'Self-hosted',
          compat5Desc: 'Any RFC 4918 implementation; without LOCK / If-Match it degrades to a soft lock and conflict copies',
          securityTitle: 'Security',
          sec1Title: 'Password never leaves the machine',
          sec1Desc: 'The WebDAV password lives in a local credentials file (mode 0600): never in config, never remote, never in API responses.',
          sec2Title: 'Config sync is off by default',
          sec2Desc: 'settings.yaml may hold API keys, so it stays opt-in through an explicit top-level key allowlist.',
          sec3Title: 'Safe extraction',
          sec3Desc: 'Path traversal and zip bombs are rejected, per-file and total limits apply, and every zip is verified by content hash.',
          faqTitle: 'FAQ',
          faq1q: 'The plugin is synced but nothing changed?',
          faq1a: 'Bundles load on dsh startup, so the panel shows "restart required" after an install. Skills appear in a new conversation without a restart.',
          faq2q: 'Where are the backups?',
          faq2a: 'Automatic merge, download overwrite and deletion propagation all back up first, under $DSH_HOME/.webdav-enhanced/backups/, with a configurable retention count.',
          faq3q: 'Where are the logs?',
          faq3a: 'The Logs tab shows them, and $DSH_HOME/.webdav-enhanced/logs/sync.jsonl stores them (rotated at 1MB). The file is safe to share when debugging.',
          faq4q: 'Can automatic merge lose data?',
          faq4a: 'No. The loser is always packed to backups first, and remote deletions only move files to trash, so a few retained backups cover a rollback.',
          faq5q: 'Will two machines collide?',
          faq5a: 'Native LOCK when the server supports it, otherwise a soft lock plus conditional manifest writes: the later writer re-reads and re-merges, up to three times. Locally, only one run can be active.',
          faq6q: 'Nutstore returns 503 or is slow?',
          faq6a: 'Nutstore rate-limits WebDAV. Increase the interval to an hour or more and exclude large directories.',
          aboutTitle: 'About',
          aboutVersion: 'Version',
          aboutMachine: 'Machine ID',
          aboutDataDir: 'Local data directory',
          aboutRemote: 'Remote root',
          aboutProfile: 'Profile',
          aboutDocs: 'Full documentation lives in the packaged README.md',
        },
        connect: {
          url: 'WebDAV URL',
          urlHint: 'e.g. https://dav.example.com/dsh/',
          username: 'Account',
          password: 'Password',
          passwordHint: 'Leave blank to keep the saved password',
          hasPassword: 'Password saved',
          noPassword: 'No password saved yet',
          advanced: 'Advanced',
          timeout: 'Request timeout (ms)',
          remoteRoot: 'Remote sync root',
          tls: 'Ignore TLS certificate errors',
          tlsHint: 'Only for self-signed intranet certificates',
          ok: 'Connected',
          fail: 'Connection failed',
          server: 'Server',
          caps: 'Capabilities',
          capsLock: 'Native LOCK',
          capsIf: 'If-Match',
          capsYes: 'yes',
          capsNo: 'no',
          steps: 'Steps',
          stepPropfind: 'Read',
          stepMkcol: 'Mkdir',
          stepPut: 'Write',
          stepReadback: 'Read back',
          http401: 'Authentication failed: wrong account or password. Use an app password for Nutstore / Nextcloud, and re-enter the password here if it changed.',
          http403: 'No write permission: read-only account or a restricted folder.',
          http404: 'Not found: the URL may be missing a path segment.',
          http405: 'The server rejects this operation (MKCOL may be disabled).',
          http409: 'Missing parent collection or path conflict.',
          http423: 'Locked on the server: usually a leftover LOCK from an earlier test or sync. Wait 10–60s or release it, then retry.',
          http507: 'Not enough remote space.',
        },
        scope: {
          bundles: 'Plugins',
          skills: 'Skills',
          configs: 'Models & config',
          all: 'Everything',
          selected: 'Selected only',
          none: 'Skip',
          exclude: 'Excluded item names',
          includeKeys: 'Only these top-level keys',
          chipHint: 'Enter or comma to add; removable tags appear on the right',
          addChip: 'Type and press Enter',
          empty: 'Nothing scanned',
          loading: 'Scanning…',
          configsTip: 'Config may contain API keys, so it is off by default; sensitive top-level keys (apiKey / token / secret) are never synced.',
          save: 'Save content',
          selectedCount: '{n} of {total} selected',
        },
        mode: {
          direction: 'Direction',
          both: 'Two-way',
          upload: 'Upload only',
          download: 'Download only',
          directionHint: 'Two-way syncs both ends; one-way only pushes or only pulls.',
          schedule: 'Scheduled sync',
          scheduleHint: 'When on, a run starts every interval with a 0–5 minute jitter so machines do not collide.',
          interval: 'Interval (hours)',
          conflictPolicy: 'Divergence policy',
          policyAuto: 'Automatic resolution (recommended)',
          policyAutoHint: 'Newer mtime, then higher version wins; the loser is backed up automatically.',
          policyMergeBackup: 'Remote wins and keep a backup',
          policyAsk: 'Flag as conflict and wait for me',
          policyLocal: 'Always local wins',
          policyRemote: 'Always remote wins',
          smartTitle: 'Smart options',
          propagate: 'Deletion propagation',
          propagateHint: 'A deletion on one side follows to the other (remote to trash, local packed first)',
          dedupe: 'Cross-entry dedupe',
          dedupeHint: 'When the remote already holds identical content, only the manifest is updated',
          autoInstall: 'Install after download',
          autoInstallHint: 'Turn off to download only, leaving the install to you',
          contentMerge: 'Merge config per key',
          contentMergeHint: 'settings.yaml merges per top-level key instead of being replaced wholesale',
          prune: 'Cleanup after sync',
          pruneHint: 'Drops remote tombstones and trash older than seven days',
          maxBackups: 'Backups to keep',
          save: 'Save mode',
        },
        logs: {
          title: 'Run logs',
          filterAll: 'All',
          filterOk: 'Success',
          filterFail: 'Failure',
          filterMerge: 'Merge',
          filterSkip: 'Skip',
          filterDelete: 'Delete',
          search: 'Search item name or message…',
          autoRefresh: 'Auto-refresh while running',
          empty: 'No logs yet. After one sync every step is listed by category.',
          noMatch: 'No matching log entry',
          notSupported: 'This backend has no log endpoint yet; restart dsh to enable it.',
          exportDone: 'Copied to clipboard',
          exportFail: 'Copy failed; read the log file instead',
          showing: '{n} shown',
        },
        diag: {
          envTitle: 'Environment',
          dsh: 'dsh version',
          profile: 'Profile',
          home: 'Data directory',
          profileDir: 'Profile directory',
          skillsDir: 'Skills directory',
          settings: 'settings.yaml',
          generation: 'Host generation',
          lockTitle: 'Sync lock',
          lockFree: 'None (ready)',
          lockHeld: 'Held by {machine} until {time}',
          capsTitle: 'Server capabilities',
          dangerTitle: 'Danger zone',
          resetTitle: 'Reset local sync state',
          resetDesc: 'Clears local records and credentials; remote data is untouched.',
          resetConfirm: 'Reset now? Local credentials and sync records will be cleared.',
          resetArmed: 'Click again to confirm',
          clearTitle: 'Clear remote sync data',
          clearDesc: 'Deletes every remote sync file irreversibly. Type DELETE to confirm.',
          clearPlaceholder: 'Type DELETE',
          notFound: 'not detected',
        },
        item: {
          upload: 'Upload',
          download: 'Download',
          merge: 'Merge',
          skip: 'Skip',
          deleteLocal: 'Remove local',
          deleteRemote: 'Remove remote',
          conflict: 'Conflict',
        },
        status: {
          pending: 'Pending',
          running: 'Running',
          ok: 'Succeeded',
          failed: 'Failed',
          skipped: 'Skipped',
          merged: 'Merged',
          deleted: 'Deleted',
          conflict: 'Conflict',
        },
        phase: {
          idle: 'Idle',
          scan: 'Scanning local',
          manifest: 'Reading manifest',
          plan: 'Planning',
          download: 'Downloading',
          upload: 'Uploading',
          prune: 'Pruning remote',
          finalize: 'Finalizing',
          done: 'Done',
          error: 'Error',
          cancelled: 'Cancelled',
        },
        cat: {
          sync: 'Sync',
          upload: 'Upload',
          download: 'Download',
          merge: 'Merge',
          conflict: 'Conflict',
          skip: 'Skip',
          delete: 'Delete',
          dedupe: 'Dedupe',
          connection: 'Connection',
          schedule: 'Schedule',
          env: 'Environment',
          system: 'System',
          prune: 'Prune',
        },
        level: {
          info: 'Info',
          success: 'Success',
          warn: 'Warning',
          error: 'Error',
        },
        common: {
          error: 'Error',
          loading: 'Loading…',
          empty: 'Nothing here',
          close: 'Close',
          cancel: 'Cancel',
          confirm: 'Confirm',
          yes: 'Yes',
          no: 'No',
          unknown: 'unknown',
          bytes: 'B',
          seconds: 's',
          minutes: 'min',
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

    /** 追加子节点：字符串 / 数字 / 节点 / 数组 / null 都安全 */
    function append(node, child) {
      if (child === null || child === undefined || child === false || child === true) return
      if (Array.isArray(child)) {
        for (const item of child) append(node, item)
        return
      }
      if (typeof child === 'object' && typeof child.nodeType === 'number') {
        node.appendChild(child)
        return
      }
      node.appendChild(document.createTextNode(String(child)))
    }

    /** 创建元素：children 可以是字符串、节点或数组（旧实现只接受字符串） */
    function h(tag, cls, ...children) {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      for (const child of children) append(node, child)
      return node
    }

    function svg(paths, size) {
      const wrap = document.createElement('span')
      wrap.className = 'wds-ico'
      const attrs =
        'viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" ' +
        'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      wrap.innerHTML = '<svg ' + attrs + '>' + paths + '</svg>'
      return wrap
    }

    const ICONS = {
      cloud:
        '<path d="M7 18.5a3.6 3.6 0 0 1-.5-7.16A5.2 5.2 0 0 1 16.4 9.3 4.2 4.2 0 0 1 17.5 18.5"/>' +
        '<path d="M12 12v6"/><path d="M9.6 15.4 12 18l2.4-2.6"/>',
      up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
      down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
      swap: '<path d="M7 8h11"/><path d="m15 5 3 3-3 3"/><path d="M17 16H6"/><path d="m9 13-3 3 3 3"/>',
      skip: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
      trash: '<path d="M4 7h16"/><path d="M10 4h4"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>',
      check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
      x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
      alert: '<path d="M12 4 3.5 19h17z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
      refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
      plug: '<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 17v4"/>',
      book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21z"/><path d="M5 5.5V21"/>',
      list: '<path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
      sliders: '<path d="M4 8h10"/><path d="M18 8h2"/><circle cx="16" cy="8" r="2"/><path d="M4 16h4"/><path d="M12 16h8"/><circle cx="10" cy="16" r="2"/>',
      activity: '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
      shield: '<path d="M12 3 5 6v6c0 4.2 2.9 7.7 7 9 4.1-1.3 7-4.8 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
      db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
      clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
      cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 2.5v3.5"/><path d="M14 2.5v3.5"/><path d="M10 18v3.5"/><path d="M14 18v3.5"/><path d="M2.5 10H6"/><path d="M2.5 14H6"/><path d="M18 10h3.5"/><path d="M18 14h3.5"/>',
      lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
      downloadBox: '<path d="M12 4v10"/><path d="m8 10.5 4 4 4-4"/><path d="M5 18h14"/>',
    }

    function icon(name, size) {
      return svg(ICONS[name] || ICONS.cloud, size)
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

    function button(labelText, variant) {
      const node = h('button', 'wds-btn' + (variant ? ' wds-btn-' + variant : ''), labelText)
      node.type = 'button'
      return node
    }

    function iconButton(iconName, labelText, variant) {
      const node = button('', variant)
      node.appendChild(icon(iconName, 14))
      if (labelText) node.appendChild(h('span', '', labelText))
      node.setAttribute('aria-label', labelText || iconName)
      return node
    }

    /** 胶囊分段控件（模式 / 方向这类 2~3 选项） */
    function segmented(options, value, onChange) {
      const wrap = h('div', 'wds-seg')
      wrap.setAttribute('role', 'tablist')
      const buttons = {}
      let current = value
      function apply(val, silent) {
        current = val
        for (const key of Object.keys(buttons)) {
          const active = key === val
          buttons[key].setAttribute('aria-selected', active ? 'true' : 'false')
          buttons[key].classList.toggle('active', active)
        }
        if (!silent && onChange) onChange(val)
      }
      for (const [val, label] of options) {
        const node = h('button', 'wds-seg-btn', label)
        node.type = 'button'
        node.setAttribute('role', 'tab')
        node.onclick = () => apply(val, false)
        buttons[val] = node
        wrap.appendChild(node)
      }
      wrap.setValue = (val) => apply(val, true)
      wrap.getValue = () => current
      apply(value, true)
      return wrap
    }

    /** 开关行：左侧标题+说明，右侧 pill 开关 */
    function switchRow(labelText, hint, checked) {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.role = 'switch'
      box.checked = !!checked
      const track = h('span', 'wds-switch-track')
      const control = h('span', 'wds-switch', box, track)
      const text = h('span', 'wds-switch-text', h('span', 'wds-switch-label', labelText), hint ? h('span', 'wds-switch-hint', hint) : null)
      const row = h('label', 'wds-switch-row', text, control)
      row.input = box
      row.setChecked = (val) => {
        box.checked = !!val
      }
      return row
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

    function card(title, subtitle, ...children) {
      const node = h('section', 'wds-card')
      if (title) {
        const head = h(
          'div',
          'wds-card-head',
          h('div', 'wds-card-head-text', h('h3', 'wds-card-title', title), subtitle ? h('p', 'wds-card-sub', subtitle) : null),
        )
        node.appendChild(head)
      }
      for (const child of children) append(node, child)
      return node
    }

    function statusBox(parent) {
      const box = h('div', 'wds-status')
      box.setAttribute('role', 'status')
      if (parent) parent.appendChild(box)
      return {
        node: box,
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

    function emptyState(iconName, title, desc) {
      return h(
        'div',
        'wds-empty',
        icon(iconName || 'cloud', 30),
        h('div', 'wds-empty-title', title),
        desc ? h('div', 'wds-empty-desc', desc) : null,
      )
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
        const err = new Error(detail)
        err.status = res.status
        throw err
      }
      return parsed
    }

    /** 新端点缺失时（旧后端）不要炸面板，返回 null 并标记 */
    async function apiOptional(path, options) {
      try {
        return await api(path, options)
      } catch (err) {
        if (err && err.status === 404) return null
        throw err
      }
    }

    function splitList(value) {
      return String(value || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }

    function joinList(list) {
      return Array.isArray(list) ? list.join(', ') : ''
    }

    function uniquePush(list, value) {
      const text = String(value || '').trim()
      if (!text) return list
      if (list.indexOf(text) === -1) list.push(text)
      return list
    }

    function formatTime(iso, locale) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return iso
      }
    }

    function formatClock(iso) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleTimeString(undefined, { hour12: false })
      } catch {
        return iso
      }
    }

    function formatDuration(ms) {
      if (!ms && ms !== 0) return '—'
      if (ms < 1000) return Math.round(ms) + ' ms'
      const sec = ms / 1000
      if (sec < 60) return (Math.round(sec * 10) / 10) + ' s'
      const min = Math.floor(sec / 60)
      return min + ' m ' + Math.round(sec - min * 60) + ' s'
    }

    function formatBytes(n) {
      if (!n && n !== 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (Math.round((n / 1024) * 10) / 10) + ' KB'
      return (Math.round((n / 1024 / 1024) * 10) / 10) + ' MB'
    }

    function fillTemplate(text, vars) {
      return String(text || '').replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key]) : match,
      )
    }

    function clearNode(node) {
      while (node && node.firstChild) node.removeChild(node.firstChild)
    }

    // ---------------------------------------------------------------- 样式

    const css = `
    .wds-root {
      --wds-line: var(--dsw-alias-border-l1, rgba(127, 127, 127, .22));
      --wds-line-strong: var(--dsw-alias-border-l2, rgba(127, 127, 127, .36));
      --wds-bg: var(--dsw-alias-bg-base, transparent);
      --wds-surface: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .04));
      --wds-surface-2: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .08));
      --wds-accent: var(--dsw-alias-brand-primary, #4176e6);
      --wds-text: var(--dsw-alias-label-primary, inherit);
      --wds-muted: var(--dsw-alias-label-secondary, rgba(127, 127, 127, .9));
      --wds-ok: var(--dsw-alias-state-success-primary, #1a9c53);
      --wds-warn: var(--dsw-alias-state-warn-primary, #c47c18);
      --wds-err: var(--dsw-alias-state-error-primary, #d92d20);
      --wds-idle: var(--dsw-alias-state-idle-primary, rgba(127, 127, 127, .7));
      --wds-radius-sm: 8px;
      --wds-radius: 12px;
      display: block;
      color: var(--wds-text);
      font-size: 13px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .wds-root *, .wds-root *::before, .wds-root *::after { box-sizing: border-box; }

    .wds-shell { display: flex; flex-direction: column; gap: 14px; max-width: 840px; }
    .wds-root[data-variant="settings"] .wds-shell { max-width: 100%; }
    /* 行级配置页的标题由宿主页面给出，这里只留操作区，避免同一个标题出现两次 */
    .wds-root[data-variant="row"] .wds-hero-text { display: none; }
    .wds-root[data-variant="row"] .wds-hero { padding: 10px 14px; }
    .wds-root[data-variant="row"] .wds-hero-mark { width: 30px; height: 30px; flex-basis: 30px; }

    /* ---------- 头部 ---------- */
    .wds-hero {
      position: relative; overflow: hidden;
      display: flex; align-items: center; gap: 14px;
      padding: 16px 18px;
      border: 1px solid var(--wds-line); border-radius: 14px;
      background: var(--wds-surface);
    }
    .wds-hero::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(120% 160% at 100% 0%,
        color-mix(in srgb, var(--wds-accent) 16%, transparent) 0%,
        transparent 62%);
    }
    .wds-hero-mark {
      position: relative; z-index: 1;
      display: grid; place-items: center;
      width: 40px; height: 40px; flex: 0 0 40px;
      border-radius: 12px;
      color: var(--wds-accent);
      background: color-mix(in srgb, var(--wds-accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--wds-accent) 26%, transparent);
    }
    .wds-hero-text { position: relative; z-index: 1; flex: 1 1 auto; min-width: 0; }
    .wds-hero-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
    .wds-hero-sub { margin: 2px 0 0; font-size: 12px; color: var(--wds-muted); }
    .wds-hero-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

    .wds-pill {
      display: inline-flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 10px; border-radius: 999px;
      font-size: 11.5px; white-space: nowrap; color: var(--wds-muted);
      border: 1px solid var(--wds-line-strong); background: var(--wds-bg);
    }
    .wds-pill .wds-dot { background: currentColor; }
    .wds-pill[data-tone="ok"] { color: var(--wds-ok); border-color: color-mix(in srgb, var(--wds-ok) 42%, transparent); }
    .wds-pill[data-tone="warn"] { color: var(--wds-warn); border-color: color-mix(in srgb, var(--wds-warn) 42%, transparent); }
    .wds-pill[data-tone="err"] { color: var(--wds-err); border-color: color-mix(in srgb, var(--wds-err) 42%, transparent); }
    .wds-pill[data-tone="run"] { color: var(--wds-accent); border-color: color-mix(in srgb, var(--wds-accent) 42%, transparent); }

    /* ---------- 页签 ---------- */
    .wds-tabs {
      display: flex; gap: 2px; padding: 4px;
      border: 1px solid var(--wds-line); border-radius: 12px;
      background: var(--wds-surface);
      overflow-x: auto; scrollbar-width: none;
    }
    .wds-tabs::-webkit-scrollbar { display: none; }
    .wds-tab {
      flex: 0 0 auto; padding: 6px 13px; border: 0; border-radius: 9px;
      background: transparent; color: var(--wds-muted);
      font: inherit; font-size: 12.5px; cursor: pointer;
      transition: color .16s ease, background .16s ease, box-shadow .16s ease;
    }
    .wds-tab:hover { color: var(--wds-text); background: var(--wds-surface-2); }
    .wds-tab[aria-selected="true"] {
      color: var(--wds-accent);
      background: color-mix(in srgb, var(--wds-accent) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wds-accent) 26%, transparent);
    }
    .wds-tab:focus-visible { outline: 2px solid var(--wds-accent); outline-offset: 1px; }

    /* ---------- 卡片 ---------- */
    .wds-pane { display: none; flex-direction: column; gap: 12px; }
    .wds-pane.active { display: flex; }
    .wds-card {
      border: 1px solid var(--wds-line); border-radius: 12px;
      background: var(--wds-surface); padding: 14px;
      animation: wds-rise .26s cubic-bezier(.22, 1, .36, 1) both;
    }
    .wds-pane > .wds-card:nth-child(2) { animation-delay: .03s; }
    .wds-pane > .wds-card:nth-child(3) { animation-delay: .06s; }
    .wds-pane > .wds-card:nth-child(4) { animation-delay: .09s; }
    .wds-pane > .wds-card:nth-child(n+5) { animation-delay: .12s; }
    .wds-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .wds-card-head-text { min-width: 0; }
    .wds-card-title { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -.005em; }
    .wds-card-sub { margin: 2px 0 0; font-size: 11.5px; color: var(--wds-muted); }
    .wds-card--danger { border-color: color-mix(in srgb, var(--wds-err) 34%, transparent); background: color-mix(in srgb, var(--wds-err) 4%, transparent); }

    .wds-eyebrow {
      display: block; margin: 0 0 8px;
      font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
      color: var(--wds-muted);
    }

    /* ---------- 表单 ---------- */
    .wds-field { display: grid; gap: 5px; margin-bottom: 12px; }
    .wds-field:last-child { margin-bottom: 0; }
    .wds-label { font-size: 12px; font-weight: 500; color: var(--wds-muted); }
    .wds-hint { font-size: 11.5px; color: var(--wds-muted); }
    .wds-input {
      width: 100%; height: 34px; padding: 0 10px;
      font: inherit; font-size: 12.5px; color: var(--wds-text);
      background: var(--wds-bg);
      border: 1px solid var(--wds-line); border-radius: var(--wds-radius-sm);
      outline: none; transition: border-color .16s ease, box-shadow .16s ease;
    }
    .wds-input::placeholder { color: var(--wds-muted); }
    .wds-input:hover { border-color: var(--wds-line-strong); }
    .wds-input:focus-visible {
      border-color: var(--wds-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wds-accent) 18%, transparent);
    }
    select.wds-input { cursor: pointer; padding-right: 26px; }
    .wds-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .wds-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 12px; }

    .wds-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }
    .wds-check input { margin: 0; accent-color: var(--wds-accent); }

    .wds-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
    .wds-actions .wds-spacer { flex: 1 1 auto; }

    /* ---------- 按钮 ---------- */
    .wds-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 32px; padding: 0 14px;
      font: inherit; font-size: 12.5px; color: var(--wds-text);
      background: var(--wds-surface);
      border: 1px solid var(--wds-line-strong); border-radius: var(--wds-radius-sm);
      cursor: pointer; white-space: nowrap;
      transition: background .16s ease, border-color .16s ease, transform .1s ease, opacity .16s ease;
    }
    .wds-btn:hover:not(:disabled) { background: var(--wds-surface-2); }
    .wds-btn:active:not(:disabled) { transform: translateY(1px); }
    .wds-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--wds-accent) 24%, transparent); }
    .wds-btn:disabled { opacity: .5; cursor: not-allowed; }
    .wds-btn-primary {
      color: #fff; background: var(--wds-accent); border-color: transparent;
    }
    .wds-btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--wds-accent) 88%, #000); }
    .wds-btn-ghost { background: transparent; border-color: transparent; color: var(--wds-muted); }
    .wds-btn-ghost:hover:not(:disabled) { background: var(--wds-surface-2); color: var(--wds-text); }
    .wds-btn-danger { color: var(--wds-err); border-color: color-mix(in srgb, var(--wds-err) 42%, transparent); background: transparent; }
    .wds-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--wds-err) 10%, transparent); }
    .wds-ico { display: inline-flex; flex: 0 0 auto; }

    /* ---------- 分段控件 ---------- */
    .wds-seg {
      display: inline-flex; gap: 2px; padding: 3px;
      border: 1px solid var(--wds-line); border-radius: 10px;
      background: var(--wds-surface-2);
    }
    .wds-seg-btn {
      border: 0; background: transparent; color: var(--wds-muted);
      font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 7px;
      cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease;
    }
    .wds-seg-btn:hover { color: var(--wds-text); }
    .wds-seg-btn[aria-selected="true"] {
      color: var(--wds-text); background: var(--wds-surface);
      box-shadow: 0 1px 3px color-mix(in srgb, var(--wds-text) 14%, transparent);
    }
    .wds-seg-btn:focus-visible { outline: 2px solid var(--wds-accent); outline-offset: 1px; }

    /* ---------- 开关 ---------- */
    .wds-switch-row {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 9px 0; border-bottom: 1px dashed var(--wds-line); cursor: pointer;
    }
    .wds-switch-row:last-of-type { border-bottom: 0; }
    .wds-switch-text { display: grid; gap: 2px; min-width: 0; }
    .wds-switch-label { font-size: 12.5px; }
    .wds-switch-hint { font-size: 11.5px; color: var(--wds-muted); }
    .wds-switch { position: relative; flex: 0 0 auto; width: 38px; height: 22px; }
    .wds-switch input {
      position: absolute; inset: 0; width: 100%; height: 100%;
      margin: 0; opacity: 0; cursor: pointer; z-index: 1;
    }
    .wds-switch-track {
      position: absolute; inset: 0; border-radius: 999px;
      background: color-mix(in srgb, var(--wds-text) 18%, transparent);
      transition: background .18s ease;
    }
    .wds-switch-track::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 18px; height: 18px; border-radius: 50%;
      background: var(--wds-bg);
      box-shadow: 0 1px 3px color-mix(in srgb, var(--wds-text) 26%, transparent);
      transition: transform .18s cubic-bezier(.34, 1.4, .64, 1);
    }
    .wds-switch input:checked + .wds-switch-track { background: var(--wds-accent); }
    .wds-switch input:checked + .wds-switch-track::after { transform: translateX(16px); }
    .wds-switch input:focus-visible + .wds-switch-track {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wds-accent) 22%, transparent);
    }

    /* ---------- 状态条 ---------- */
    .wds-status {
      display: none; margin-top: 12px; padding: 9px 11px;
      border-radius: var(--wds-radius-sm); border: 1px solid var(--wds-line);
      background: var(--wds-surface-2); font-size: 12px; white-space: pre-line;
    }
    .wds-status.show { display: block; }
    .wds-status.ok { color: var(--wds-ok); border-color: color-mix(in srgb, var(--wds-ok) 40%, transparent); background: color-mix(in srgb, var(--wds-ok) 8%, transparent); }
    .wds-status.err { color: var(--wds-err); border-color: color-mix(in srgb, var(--wds-err) 40%, transparent); background: color-mix(in srgb, var(--wds-err) 8%, transparent); }
    .wds-status.warn { color: var(--wds-warn); border-color: color-mix(in srgb, var(--wds-warn) 40%, transparent); background: color-mix(in srgb, var(--wds-warn) 8%, transparent); }

    /* ---------- 提示块 ---------- */
    .wds-note {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 9px 11px; border-radius: var(--wds-radius-sm);
      border: 1px solid var(--wds-line); background: var(--wds-surface-2);
      font-size: 12px; color: var(--wds-muted);
    }
    .wds-note[data-tone="warn"] { color: var(--wds-text); border-color: color-mix(in srgb, var(--wds-warn) 36%, transparent); background: color-mix(in srgb, var(--wds-warn) 8%, transparent); }
    .wds-note[data-tone="err"] { color: var(--wds-err); border-color: color-mix(in srgb, var(--wds-err) 36%, transparent); background: color-mix(in srgb, var(--wds-err) 8%, transparent); }
    .wds-note[data-tone="ok"] { color: var(--wds-ok); border-color: color-mix(in srgb, var(--wds-ok) 36%, transparent); background: color-mix(in srgb, var(--wds-ok) 8%, transparent); }
    .wds-note .wds-ico { margin-top: 1px; }

    /* ---------- 指标块 ---------- */
    .wds-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 10px; }
    .wds-tile {
      display: grid; gap: 3px; padding: 10px 12px;
      border: 1px solid var(--wds-line); border-radius: 11px;
      background: var(--wds-bg);
    }
    .wds-tile-label { font-size: 11px; color: var(--wds-muted); letter-spacing: .02em; }
    .wds-tile-value {
      font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .wds-tile-sub { font-size: 11px; color: var(--wds-muted); font-variant-numeric: tabular-nums; }

    /* ---------- 进度 ---------- */
    .wds-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .wds-progress-phase { font-size: 12.5px; font-weight: 600; }
    .wds-progress-pct { font-size: 12px; color: var(--wds-muted); font-variant-numeric: tabular-nums; }
    .wds-bar {
      position: relative; height: 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--wds-text) 12%, transparent);
      overflow: hidden;
    }
    .wds-bar-fill {
      height: 100%; width: 0%; border-radius: 999px;
      background: var(--wds-accent);
      background-image: linear-gradient(45deg,
        rgba(255, 255, 255, .26) 25%, transparent 25%, transparent 50%,
        rgba(255, 255, 255, .26) 50%, rgba(255, 255, 255, .26) 75%, transparent 75%, transparent);
      background-size: 16px 16px;
      transition: width .4s cubic-bezier(.22, 1, .36, 1);
      animation: wds-stripes .9s linear infinite;
    }
    .wds-bar[data-tone="err"] .wds-bar-fill { background-color: var(--wds-err); animation: none; }
    .wds-bar[data-tone="ok"] .wds-bar-fill { background-color: var(--wds-ok); animation: none; }
    .wds-progress-meta {
      display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 9px;
      font-size: 11.5px; color: var(--wds-muted); font-variant-numeric: tabular-nums;
    }
    .wds-progress-meta b { color: var(--wds-text); font-weight: 600; }

    /* ---------- 计数芯片 ---------- */
    .wds-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .wds-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 9px; border-radius: 999px;
      font-size: 11.5px; font-variant-numeric: tabular-nums;
      color: var(--wds-muted);
      border: 1px solid var(--wds-line); background: var(--wds-bg);
    }
    .wds-chip b { color: var(--wds-text); font-weight: 600; }
    .wds-chip[data-tone="ok"] { color: var(--wds-ok); border-color: color-mix(in srgb, var(--wds-ok) 36%, transparent); }
    .wds-chip[data-tone="err"] { color: var(--wds-err); border-color: color-mix(in srgb, var(--wds-err) 36%, transparent); }
    .wds-chip[data-tone="warn"] { color: var(--wds-warn); border-color: color-mix(in srgb, var(--wds-warn) 36%, transparent); }
    .wds-chip[data-tone="accent"] { color: var(--wds-accent); border-color: color-mix(in srgb, var(--wds-accent) 36%, transparent); }
    .wds-chip[data-tone="ok"] b, .wds-chip[data-tone="err"] b,
    .wds-chip[data-tone="warn"] b, .wds-chip[data-tone="accent"] b { color: inherit; }

    .wds-chips-editor { display: grid; gap: 8px; }
    .wds-chips-editor .wds-chips:empty { display: none; }
    .wds-chip-x {
      display: inline-flex; align-items: center; justify-content: center;
      width: 15px; height: 15px; margin-left: 1px;
      padding: 0; border: 0; border-radius: 50%;
      background: color-mix(in srgb, currentColor 16%, transparent);
      color: inherit; font-size: 11px; line-height: 1; cursor: pointer;
      transition: background .14s ease;
    }
    .wds-chip-x:hover { background: color-mix(in srgb, currentColor 30%, transparent); }
    .wds-chip-x:focus-visible { outline: 2px solid var(--wds-accent); outline-offset: 1px; }

    .wds-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }

    /* ---------- 条目行 ---------- */
    .wds-rows { display: grid; gap: 1px; margin-top: 4px; max-height: 300px; overflow: auto; }
    .wds-row {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 8px; border-radius: 8px; font-size: 12px;
      transition: background .14s ease;
    }
    .wds-row:hover { background: var(--wds-surface-2); }
    .wds-row-main { flex: 1 1 auto; min-width: 0; display: grid; gap: 1px; }
    .wds-row-name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .wds-row-reason { font-size: 11.5px; color: var(--wds-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wds-row-badge { flex: 0 0 auto; }
    .wds-row-extra { flex: 0 0 auto; font-size: 11px; color: var(--wds-muted); font-variant-numeric: tabular-nums; }

    .wds-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 6px;
      font-size: 11px; white-space: nowrap;
      color: var(--wds-muted); background: var(--wds-surface-2);
      border: 1px solid var(--wds-line);
    }
    .wds-badge[data-tone="ok"] { color: var(--wds-ok); background: color-mix(in srgb, var(--wds-ok) 10%, transparent); border-color: color-mix(in srgb, var(--wds-ok) 30%, transparent); }
    .wds-badge[data-tone="err"] { color: var(--wds-err); background: color-mix(in srgb, var(--wds-err) 10%, transparent); border-color: color-mix(in srgb, var(--wds-err) 30%, transparent); }
    .wds-badge[data-tone="warn"] { color: var(--wds-warn); background: color-mix(in srgb, var(--wds-warn) 10%, transparent); border-color: color-mix(in srgb, var(--wds-warn) 30%, transparent); }
    .wds-badge[data-tone="accent"] { color: var(--wds-accent); background: color-mix(in srgb, var(--wds-accent) 10%, transparent); border-color: color-mix(in srgb, var(--wds-accent) 30%, transparent); }

    /* ---------- 说明页 ---------- */
    .wds-guide-hero {
      position: relative; overflow: hidden;
      padding: 18px;
      border: 1px solid var(--wds-line); border-radius: 14px;
      background: var(--wds-surface);
    }
    .wds-guide-hero::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(130% 150% at 0% 0%,
        color-mix(in srgb, var(--wds-accent) 15%, transparent) 0%, transparent 58%);
    }
    .wds-guide-hero > * { position: relative; z-index: 1; }
    .wds-guide-title { margin: 0 0 6px; font-size: 17px; font-weight: 650; letter-spacing: -.02em; }
    .wds-guide-lead { margin: 0; max-width: 56ch; font-size: 12.5px; color: var(--wds-muted); line-height: 1.7; }
    .wds-guide-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }

    .wds-steps { display: grid; gap: 12px; }
    .wds-step { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 11px; align-items: start; }
    .wds-step-num {
      display: grid; place-items: center; width: 24px; height: 24px;
      border-radius: 8px; font-size: 11.5px; font-weight: 600;
      color: var(--wds-accent);
      background: color-mix(in srgb, var(--wds-accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--wds-accent) 26%, transparent);
      font-variant-numeric: tabular-nums;
    }
    .wds-step-title { font-size: 12.5px; font-weight: 600; }
    .wds-step-desc { font-size: 12px; color: var(--wds-muted); line-height: 1.65; }

    .wds-feat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: 10px; }
    .wds-feat {
      display: grid; gap: 7px; padding: 13px;
      border: 1px solid var(--wds-line); border-radius: 11px;
      background: var(--wds-bg);
      transition: border-color .16s ease, transform .16s ease;
    }
    .wds-feat:hover { border-color: var(--wds-line-strong); transform: translateY(-1px); }
    .wds-feat-icon {
      display: grid; place-items: center; width: 28px; height: 28px;
      border-radius: 9px; color: var(--wds-accent);
      background: color-mix(in srgb, var(--wds-accent) 10%, transparent);
    }
    .wds-feat-title { font-size: 12.5px; font-weight: 600; }
    .wds-feat-desc { font-size: 11.5px; color: var(--wds-muted); line-height: 1.65; }

    .wds-defs { display: grid; gap: 9px; }
    .wds-def { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; font-size: 12px; align-items: start; }
    .wds-def dt { font-weight: 600; color: var(--wds-accent); }
    .wds-def dd { margin: 0; color: var(--wds-muted); line-height: 1.65; }

    .wds-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .wds-table th, .wds-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--wds-line); vertical-align: top; }
    .wds-table th { font-size: 11px; font-weight: 600; color: var(--wds-muted); letter-spacing: .02em; }
    .wds-table td { color: var(--wds-muted); }
    .wds-table td:first-child { color: var(--wds-text); font-weight: 500; white-space: nowrap; }
    .wds-table tbody tr:last-child td { border-bottom: 0; }
    .wds-table tbody tr:hover td { background: var(--wds-surface-2); }

    .wds-faq { border: 1px solid var(--wds-line); border-radius: 10px; background: var(--wds-bg); overflow: hidden; }
    .wds-faq + .wds-faq { margin-top: 6px; }
    .wds-faq[open] { background: var(--wds-surface-2); }
    .wds-faq > summary {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 12px; cursor: pointer; font-size: 12.5px; list-style: none;
    }
    .wds-faq > summary::-webkit-details-marker { display: none; }
    .wds-faq > summary::after { content: '+'; color: var(--wds-muted); font-size: 15px; line-height: 1; }
    .wds-faq[open] > summary::after { content: '−'; }
    .wds-faq > summary:focus-visible { outline: 2px solid var(--wds-accent); outline-offset: -2px; }
    .wds-faq-body { margin: 0; padding: 0 12px 11px; font-size: 12px; color: var(--wds-muted); line-height: 1.7; }

    .wds-kv { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 7px 12px; font-size: 12px; margin: 0; }
    .wds-kv dt { color: var(--wds-muted); }
    .wds-kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

    /* ---------- 日志 ---------- */
    .wds-log-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
    .wds-log-search { flex: 1 1 180px; min-width: 140px; }
    .wds-log-list {
      display: grid; max-height: 400px; overflow: auto;
      border: 1px solid var(--wds-line); border-radius: 10px; background: var(--wds-bg);
    }
    .wds-log-row {
      display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 10px;
      padding: 7px 10px; font-size: 12px; align-items: start;
    }
    .wds-log-row + .wds-log-row { border-top: 1px solid color-mix(in srgb, var(--wds-line) 60%, transparent); }
    .wds-log-row:hover { background: var(--wds-surface-2); }
    .wds-log-time { font-size: 11px; color: var(--wds-muted); font-variant-numeric: tabular-nums; padding-top: 2px; }
    .wds-log-body { min-width: 0; display: grid; gap: 2px; }
    .wds-log-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .wds-log-name { font-size: 11.5px; color: var(--wds-text); font-weight: 500; overflow-wrap: anywhere; }
    .wds-log-msg { color: var(--wds-muted); overflow-wrap: anywhere; line-height: 1.55; }
    .wds-log-detail { font-size: 11px; color: var(--wds-muted); opacity: .9; overflow-wrap: anywhere; }

    /* ---------- 空态 / 骨架 ---------- */
    .wds-empty { display: grid; justify-items: center; gap: 6px; padding: 26px 12px; text-align: center; color: var(--wds-muted); }
    .wds-empty .wds-ico { opacity: .45; }
    .wds-empty-title { font-size: 12.5px; color: var(--wds-text); }
    .wds-empty-desc { font-size: 11.5px; max-width: 46ch; line-height: 1.65; }

    /* ---------- 页签筛选（日志） ---------- */
    .wds-filter {
      cursor: pointer; font: inherit; font-size: 11.5px; color: var(--wds-muted);
      background: var(--wds-bg); border: 1px solid var(--wds-line);
      transition: color .14s ease, background .14s ease, border-color .14s ease;
    }
    .wds-filter:hover { color: var(--wds-text); background: var(--wds-surface-2); }
    .wds-filter[data-active="true"] {
      color: var(--wds-accent); background: color-mix(in srgb, var(--wds-accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--wds-accent) 34%, transparent);
    }
    .wds-filter:focus-visible { outline: 2px solid var(--wds-accent); outline-offset: 1px; }

    .wds-host { display: block; }

    @media (max-width: 660px) {
      .wds-hero { flex-wrap: wrap; }
      .wds-hero-actions { width: 100%; justify-content: flex-end; }
      .wds-grid-2, .wds-grid-3 { grid-template-columns: 1fr; }
      .wds-kv { grid-template-columns: 92px minmax(0, 1fr); }
      .wds-def { grid-template-columns: 1fr; gap: 3px; }
      .wds-log-row { grid-template-columns: 1fr; gap: 3px; }
      .wds-log-time { padding-top: 0; }
    }

    @keyframes wds-stripes { from { background-position: 0 0; } to { background-position: 16px 0; } }
    @keyframes wds-rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      .wds-card { animation: none; }
      .wds-bar-fill { animation: none; transition: none; }
      .wds-feat:hover { transform: none; }
    }
    `

    const TAB_ORDER = ['overview', 'guide', 'connect', 'scope', 'mode', 'logs', 'diag']

    /** 状态 → 颜色语义（ok / err / warn / accent / idle） */
    function statusTone(status) {
      if (status === 'ok') return 'ok'
      if (status === 'failed') return 'err'
      if (status === 'merged') return 'accent'
      if (status === 'conflict') return 'warn'
      if (status === 'deleted') return 'warn'
      return 'idle'
    }

    /**
     * 挂载面板。
     * @param {HTMLElement} root 容器
     * @param {{variant?: 'page'|'settings', getLocale: () => string, subscribeLocale?: (fn: () => void) => () => void}} opts
     * @returns {() => void} 释放函数
     */
    function mount(root, opts) {
      const options = opts || {}
      let disposed = false
      let cleanup = null
      let unsubLocale = null

      function boot() {
        const locale = options.getLocale()
        const t = i18n[locale] || i18n.zh
        clearNode(root)

        const style = document.createElement('style')
        style.textContent = css
        root.appendChild(style)

        const wrap = h('div', 'wds-root')
        wrap.dataset.variant = options.variant || 'page'
        const shell = h('div', 'wds-shell')
        wrap.appendChild(shell)
        root.appendChild(wrap)

        // ---------------- 状态 ----------------
        const state = {
          config: null,
          status: null,
          progress: null,
          logs: [],
          plan: null,
          supports: { progress: true, logs: true, plan: true },
          tab: 'overview',
          pollTimer: null,
          logFilter: 'all',
          logQuery: '',
          autoRefresh: true,
          notice: { tone: 'info', text: '' },
        }

        // ---------------- 头部 ----------------
        const pillText = h('span', '', t.common.loading)
        const pill = h('span', 'wds-pill', h('span', 'wds-dot'), pillText)
        const syncBtn = button('', 'primary')
        syncBtn.append(icon('refresh', 14), h('span', '', t.action.syncNow))
        const heroActions = h('div', 'wds-hero-actions', pill, syncBtn)
        const hero = h(
          'div',
          'wds-hero',
          h('span', 'wds-hero-mark', icon('cloud', 22)),
          h(
            'div',
            'wds-hero-text',
            h('h2', 'wds-hero-title', t.meta.title),
            h('p', 'wds-hero-sub', options.variant === 'settings' ? t.meta.settingsNote : t.meta.subtitle),
          ),
          heroActions,
        )

        // ---------------- 页签 ----------------
        const tabBar = h('div', 'wds-tabs')
        tabBar.setAttribute('role', 'tablist')
        const tabNodes = {}
        for (const key of TAB_ORDER) {
          const node = h('button', 'wds-tab', t.nav[key])
          node.type = 'button'
          node.setAttribute('role', 'tab')
          node.onclick = () => activate(key)
          tabNodes[key] = node
          tabBar.appendChild(node)
        }
        shell.append(hero, tabBar)
        const body = h('div', 'wds-body')
        shell.appendChild(body)

        // ---------------- 面板 ----------------
        const panes = {
          overview: buildOverview(),
          guide: buildGuide(),
          connect: buildConnect(),
          scope: buildScope(),
          mode: buildMode(),
          logs: buildLogs(),
          diag: buildDiag(),
        }
        for (const key of TAB_ORDER) body.appendChild(panes[key].node)
        activate(state.tab)

        // ---------------- 通用小工具 ----------------
        function activate(key) {
          state.tab = key
          for (const name of TAB_ORDER) {
            const on = name === key
            tabNodes[name].setAttribute('aria-selected', on ? 'true' : 'false')
            tabNodes[name].classList.toggle('active', on)
            panes[name].node.classList.toggle('active', on)
          }
          if (panes[key].onShow) panes[key].onShow()
        }

        function makeTile(labelText) {
          const value = h('div', 'wds-tile-value', '—')
          const sub = h('div', 'wds-tile-sub', '')
          const node = h('div', 'wds-tile', h('div', 'wds-tile-label', labelText), value, sub)
          return {
            node,
            set(main, secondary) {
              value.textContent = main === null || main === undefined || main === '' ? '—' : String(main)
              sub.textContent = secondary || ''
            },
          }
        }

        function badge(labelText, tone) {
          const node = h('span', 'wds-badge', labelText)
          if (tone) node.dataset.tone = tone
          return node
        }

        function chip(labelText, value, tone) {
          const node = h('span', 'wds-chip', labelText + ' ', h('b', '', String(value === undefined ? 0 : value)))
          if (tone) node.dataset.tone = tone
          return node
        }

        function note(tone, text) {
          const node = h('div', 'wds-note', icon(tone === 'err' ? 'alert' : tone === 'ok' ? 'check' : 'alert', 14), h('span', '', text))
          node.dataset.tone = tone
          return node
        }

        function itemRow(item) {
          const tone = statusTone(item.status)
          const actionLabel = t.item[item.action] || item.action || ''
          const nameText = (actionLabel ? actionLabel + ' · ' : '') + (item.name || item.key || '')
          const main = h(
            'div',
            'wds-row-main',
            h('div', 'wds-row-name', nameText),
            h('div', 'wds-row-reason', item.reason || item.detail || ''),
          )
          const bits = []
          if (item.durationMs !== undefined && item.durationMs !== null) bits.push(formatDuration(item.durationMs))
          if (item.bytes) bits.push(formatBytes(item.bytes))
          const extra = bits.length ? h('span', 'wds-row-extra', bits.join(' · ')) : null
          const row = h('div', 'wds-row', badge(t.status[item.status] || item.status || '—', tone), main, extra)
          return row
        }

        function renderRows(container, items, limit) {
          clearNode(container)
          const list = (items || []).slice(0, limit || 80)
          if (!list.length) {
            container.appendChild(emptyState('list', t.common.empty, ''))
            return
          }
          for (const item of list) container.appendChild(itemRow(item))
        }

        function syncButtonLabel() {
          const running = state.progress && state.progress.active
          clearNode(syncBtn)
          syncBtn.appendChild(icon(running ? 'x' : 'refresh', 14))
          syncBtn.appendChild(h('span', '', running ? t.action.cancel : t.action.syncNow))
          syncBtn.classList.toggle('wds-btn-primary', !running)
          syncBtn.classList.toggle('wds-btn-danger', !!running)
        }        function renderPill() {
          const cfg = state.config
          const prog = state.progress
          const configured = !!(cfg && cfg.connection && cfg.connection.url)
          let tone = 'idle'
          let text = t.state.unconfigured
          if (prog && prog.active) {
            tone = 'run'
            text = t.state.running + ' · ' + (prog.percent || 0) + '%'
          } else if (configured) {
            const last = (prog && prog.report) || (state.status && state.status.lastReport) || null
            if (last && last.ok === false) {
              tone = 'err'
              text = t.state.failed
            } else {
              tone = 'ok'
              const at = (cfg && cfg.lastSyncAt) || (last && last.finishedAt) || null
              text = at ? formatTime(at, locale) : t.state.never
            }
          } else {
            tone = 'warn'
          }
          pill.dataset.tone = tone
          pillText.textContent = text
          syncButtonLabel()
        }

        // ---------------- 数据加载 ----------------
        async function loadConfig() {
          try {
            state.config = await api('/config')
            panes.connect.fill(state.config)
            panes.scope.fill(state.config)
            panes.mode.fill(state.config)
            panes.diag.fillConfig(state.config)
            if (panes.guide.render) panes.guide.render()
            renderPill()
          } catch (err) {
            state.config = null
            renderPill()
            panes.connect.fail(t.common.error + ': ' + err.message)
          }
        }

        async function loadStatus() {
          try {
            state.status = await api('/status')
            panes.overview.render()
            panes.diag.fillStatus(state.status)
            if (panes.guide.render) panes.guide.render()
            renderPill()
          } catch (err) {
            /* 状态读取失败不阻塞面板 */
          }
        }

        async function loadProgress() {
          let prog = null
          try {
            prog = await api('/progress')
          } catch (err) {
            if (err && err.status === 404) {
              state.supports.progress = false
              panes.overview.render()
              return
            }
            return
          }
          const wasActive = !!(state.progress && state.progress.active)
          state.progress = prog
          panes.overview.render()
          renderPill()
          if (prog && prog.active) startPolling()
          else {
            stopPolling()
            if (wasActive) {
              await loadStatus()
              await loadLogs()
              void loadConfig()
            }
          }
        }

        async function loadLogs() {
          let result = null
          try {
            result = await api('/logs?limit=200')
          } catch (err) {
            if (err && err.status === 404) {
              state.supports.logs = false
              panes.logs.render()
              return
            }
            return
          }
          state.logs = (result && result.entries) || []
          panes.logs.render()
        }

        function startPolling() {
          if (state.pollTimer) return
          state.pollTimer = setInterval(() => {
            if (disposed) return
            void tick()
          }, POLL_MS)
        }

        function stopPolling() {
          if (state.pollTimer) {
            clearInterval(state.pollTimer)
            state.pollTimer = null
          }
        }

        async function tick() {
          try {
            const prog = await api('/progress')
            if (!prog) {
              stopPolling()
              return
            }
            state.progress = prog
            panes.overview.render()
            renderPill()
            if (state.tab === 'logs' && state.autoRefresh) void loadLogs()
            if (!prog.active) {
              stopPolling()
              await loadStatus()
              await loadLogs()
              void loadConfig()
            }
          } catch (err) {
            /* 单次轮询失败忽略，下一跳重试 */
          }
        }

        async function runSync() {
          syncBtn.disabled = true
          try {
            const started = await api('/sync', { method: 'POST', body: { trigger: 'manual' } })
            if (started && started.started) {
              // 立刻先拿一帧进度，避免用户看到 0 状态的空窗
              await loadProgress()
              startPolling()
            } else {
              await loadProgress()
            }
          } catch (err) {
            state.notice = { tone: 'err', text: t.common.error + ': ' + err.message }
            panes.overview.render()
          } finally {
            syncBtn.disabled = false
          }
        }

        async function cancelRun() {
          syncBtn.disabled = true
          try {
            await api('/cancel', { method: 'POST' })
            await loadProgress()
          } catch (err) {
            state.notice = { tone: 'err', text: t.common.error + ': ' + err.message }
            panes.overview.render()
          } finally {
            syncBtn.disabled = false
          }
        }

        syncBtn.onclick = () => {
          if (state.progress && state.progress.active) void cancelRun()
          else void runSync()
        }

        // ================================================================ 概览
        function buildOverview() {
          const node = h('div', 'wds-pane')

          const tiles = h('div', 'wds-tiles')
          const tileLast = makeTile(t.overview.tileLast)
          const tileMachine = makeTile(t.overview.tileMachine)
          const tileDirection = makeTile(t.overview.tileDirection)
          const tileSchedule = makeTile(t.overview.tileSchedule)
          tiles.append(tileLast.node, tileMachine.node, tileDirection.node, tileSchedule.node)

          // ---- 进度卡 ----
          const noticeSlot = h('div', '')
          const phaseText = h('div', 'wds-progress-phase', t.overview.runIdle)
          const pctText = h('div', 'wds-progress-pct', '')
          const bar = h('div', 'wds-bar')
          bar.setAttribute('role', 'progressbar')
          bar.setAttribute('aria-valuemin', '0')
          bar.setAttribute('aria-valuemax', '100')
          bar.setAttribute('aria-valuenow', '0')
          const barFill = h('div', 'wds-bar-fill')
          bar.appendChild(barFill)
          const metaElapsed = h('span', '', '')
          const metaCurrent = h('span', '', '')
          const metaRow = h('div', 'wds-progress-meta', metaElapsed, metaCurrent)
          const liveChips = h('div', 'wds-chips')
          const liveRows = h('div', 'wds-rows')
          const idleHint = h('div', 'wds-hint', t.overview.runIdleHint)
          const cancelBtn = button(t.action.cancel, 'danger')
          cancelBtn.onclick = () => void cancelRun()

          const progressCard = h(
            'section',
            'wds-card',
            h('div', 'wds-card-head', h('div', 'wds-card-head-text', h('h3', 'wds-card-title', t.overview.runTitle))),
            noticeSlot,
            h('div', 'wds-progress-head', phaseText, pctText),
            bar,
            metaRow,
            liveChips,
            idleHint,
            liveRows,
            h('div', 'wds-actions', cancelBtn),
          )

          // ---- 上次结果卡 ----
          const resultMeta = h('div', 'wds-card-sub', '')
          const resultChips = h('div', 'wds-chips')
          const resultRows = h('div', 'wds-rows')
          const resultFailures = h('div', 'wds-rows')
          const restartSlot = h('div', '')
          const failureTitle = h('div', 'wds-eyebrow', '')
          failureTitle.style.display = 'none'
          const resultCard = h(
            'section',
            'wds-card',
            h(
              'div',
              'wds-card-head',
              h('div', 'wds-card-head-text', h('h3', 'wds-card-title', t.overview.resultTitle), resultMeta),
            ),
            resultChips,
            restartSlot,
            failureTitle,
            resultFailures,
            h('div', 'wds-eyebrow', t.overview.itemsTitle),
            resultRows,
          )

          // ---- 分析卡 ----
          const analyzeBtn = button(t.action.analyze)
          analyzeBtn.onclick = () => void runPlan()
          const analyzeSummary = h('div', 'wds-chips')
          const analyzeRows = h('div', 'wds-rows')
          const analyzeHint = h('div', 'wds-hint', t.overview.analyzeEmpty)
          const analyzeAt = h('div', 'wds-card-sub', '')
          const analyzeCard = h(
            'section',
            'wds-card',
            h(
              'div',
              'wds-card-head',
              h(
                'div',
                'wds-card-head-text',
                h('h3', 'wds-card-title', t.overview.analyzeTitle),
                h('p', 'wds-card-sub', t.overview.analyzeDesc),
              ),
              analyzeBtn,
            ),
            analyzeSummary,
            analyzeHint,
            analyzeRows,
            analyzeAt,
          )

          node.append(tiles, progressCard, resultCard, analyzeCard)

          function render() {
            const cfg = state.config
            const status = state.status || {}
            const prog = state.progress
            const report = (prog && prog.report) || status.lastReport || null
            const direction = (cfg && cfg.schedule && cfg.schedule.direction) || status.direction || 'both'
            const schedule = (cfg && cfg.schedule) || status.schedule || {}

            // tiles
            const lastIso = (cfg && cfg.lastSyncAt) || (report && report.finishedAt) || null
            tileLast.set(lastIso ? formatTime(lastIso, locale) : t.state.never, report ? formatDuration(report.durationMs) : '')
            tileMachine.set((cfg && cfg.machineId) || status.machineId || '—', (status.env && status.env.profile) || (cfg && cfg.profile) || '')
            tileDirection.set(
              direction === 'upload' ? t.overview.directionUpload : direction === 'download' ? t.overview.directionDownload : t.overview.directionBoth,
              cfg && cfg.conflictPolicy ? t.mode['policy' + policyKey(cfg.conflictPolicy)] || cfg.conflictPolicy : '',
            )
            tileSchedule.set(
              schedule.enabled ? fillTemplate(t.overview.scheduleEvery, { n: schedule.intervalHours || 1 }) : t.overview.scheduleOff,
              schedule.enabled ? '' : '',
            )

            // notice
            clearNode(noticeSlot)
            if (state.notice && state.notice.text) {
              noticeSlot.appendChild(note(state.notice.tone, state.notice.text))
            } else if (!state.supports.progress) {
              noticeSlot.appendChild(note('warn', t.overview.notSupported || t.logs.notSupported))
            }

            // live progress
            const active = !!(prog && prog.active)
            const percent = prog ? Math.max(0, Math.min(100, Math.round(prog.percent || 0))) : 0
            bar.setAttribute('aria-valuenow', String(percent))
            barFill.style.width = percent + '%'
            bar.dataset.tone = active ? 'run' : report && report.ok === false ? 'err' : report && report.ok ? 'ok' : 'idle'
            if (active) {
              phaseText.textContent = t.phase[prog.phase] || prog.phaseLabel || prog.phase || ''
              pctText.textContent = percent + '%'
              const startedAt = prog.startedAt ? new Date(prog.startedAt).getTime() : Date.now()
              metaElapsed.textContent = t.overview.elapsed + ' ' + formatDuration(Math.max(0, Date.now() - startedAt))
              metaCurrent.textContent = prog.current ? t.overview.current + ' ' + prog.current : ''
              clearNode(liveChips)
              const c = prog.counts || {}
              liveChips.append(
                chip(t.item.upload, c.upload, 'accent'),
                chip(t.item.download, c.download, 'accent'),
                chip(t.item.merge, c.merge, 'ok'),
                chip(t.item.skip, c.skip, ''),
                chip(t.item.deleteLocal, c.remove, 'warn'),
                chip(t.status.failed, c.failed, 'err'),
              )
              idleHint.style.display = 'none'
              clearNode(liveRows)
              renderRows(liveRows, prog.items || [], 40)
              liveRows.style.display = ''
              cancelBtn.style.display = ''
            } else {
              phaseText.textContent = t.overview.runIdle
              pctText.textContent = report ? (report.ok ? '100%' : '—') : ''
              metaElapsed.textContent = ''
              metaCurrent.textContent = ''
              clearNode(liveChips)
              idleHint.style.display = ''
              clearNode(liveRows)
              liveRows.style.display = 'none'
              cancelBtn.style.display = 'none'
            }

            // last result
            if (!report) {
              resultMeta.textContent = ''
              clearNode(resultChips)
              failureTitle.style.display = 'none'
              clearNode(resultFailures)
              clearNode(resultRows)
              resultRows.appendChild(emptyState('activity', t.overview.resultEmpty, ''))
            } else {
              const triggerLabel =
                report.trigger === 'scheduled'
                  ? t.overview.triggerScheduled
                  : report.trigger === 'auto-scan'
                    ? t.overview.triggerAuto
                    : t.overview.triggerManual
              resultMeta.textContent = fillTemplate(t.overview.resultAt, {
                time: formatTime(report.finishedAt || report.startedAt, locale),
                trigger: triggerLabel,
                duration: formatDuration(report.durationMs),
              })
              clearNode(resultChips)
              resultChips.append(
                chip(t.item.upload, (report.uploaded || []).length, 'accent'),
                chip(t.item.download, (report.downloaded || []).length, 'accent'),
                chip(t.item.merge, (report.merged || []).length, 'ok'),
                chip(t.item.skip, report.skipped || 0, ''),
                chip(t.item.deleteLocal, (report.deleted || []).length, 'warn'),
                chip(t.status.failed, (report.errors || []).length, 'err'),
              )
              const failures = (report.items || []).filter((item) => item.status === 'failed')
              if (failures.length) {
                failureTitle.style.display = ''
                failureTitle.textContent = t.overview.failedTitle
                renderRows(resultFailures, failures, 20)
              } else {
                failureTitle.style.display = 'none'
                clearNode(resultFailures)
              }
              clearNode(restartSlot)
              const needsRestart = report.needsRestart || []
              if (needsRestart.length) {
                restartSlot.appendChild(
                  note(
                    'warn',
                    fillTemplate(t.overview.restartNeeded, {
                      n: needsRestart.length,
                      list: needsRestart.join(', '),
                    }),
                  ),
                )
              }
              renderRows(resultRows, (report.items || []).slice(-60), 60)
            }

            // analyze
            if (state.analyzing) {
              analyzeBtn.disabled = true
              analyzeBtn.textContent = t.action.analyzing
            } else {
              analyzeBtn.disabled = false
              analyzeBtn.textContent = t.action.analyze
            }
            const plan = state.plan
            if (!plan) {
              clearNode(analyzeSummary)
              analyzeHint.style.display = ''
              clearNode(analyzeRows)
              analyzeAt.textContent = ''
            } else {
              analyzeHint.style.display = 'none'
              clearNode(analyzeSummary)
              const s = plan.summary || {}
              analyzeSummary.append(
                chip(t.item.upload, s.upload || 0, 'accent'),
                chip(t.item.download, s.download || 0, 'accent'),
                chip(t.item.merge, s.merge || 0, 'ok'),
                chip(t.item.skip, s.skip || 0, ''),
                chip(t.item.deleteLocal, s.remove || 0, 'warn'),
                chip(t.status.failed, s.conflict || 0, 'err'),
              )
              const rows = (plan.items || []).map((entry) => ({
                key: entry.key,
                name: entry.name,
                action: entry.action,
                status: entry.action === 'conflict' ? 'conflict' : 'pending',
                reason: entry.reason,
              }))
              clearNode(analyzeRows)
              renderRows(analyzeRows, rows, 80)
              analyzeAt.textContent = fillTemplate(t.overview.analyzeAt, {
                time: formatTime(plan.generatedAt, locale),
              })
            }
          }

          async function runPlan() {
            state.analyzing = true
            state.plan = null
            render()
            try {
              const plan = await apiOptional('/plan')
              if (plan === null) {
                state.supports.plan = false
                state.notice = { tone: 'warn', text: t.logs.notSupported }
              } else {
                state.plan = plan
                state.notice = { tone: 'info', text: '' }
              }
            } catch (err) {
              state.notice = { tone: 'err', text: t.common.error + ': ' + err.message }
            } finally {
              state.analyzing = false
              render()
            }
          }

          return { node, render }
        }

        // ================================================================ 说明
        function buildGuide() {
          const node = h('div', 'wds-pane')

          // 头部
          const heroCard = h(
            'section',
            'wds-guide-hero',
            h('h2', 'wds-guide-title', t.meta.title),
            h('p', 'wds-guide-lead', t.guide.lead),
            h(
              'div',
              'wds-guide-chips',
              h('span', 'wds-chip', h('span', 'wds-dot'), t.guide.chip1),
              h('span', 'wds-chip', h('span', 'wds-dot'), t.guide.chip2),
              h('span', 'wds-chip', h('span', 'wds-dot'), t.guide.chip3),
            ),
          )

          // 三步上手
          const steps = h('div', 'wds-steps')
          const stepData = [
            [t.guide.quick1Title, t.guide.quick1Desc],
            [t.guide.quick2Title, t.guide.quick2Desc],
            [t.guide.quick3Title, t.guide.quick3Desc],
            [t.guide.quick4Title, t.guide.quick4Desc],
          ]
          stepData.forEach((pair, index) => {
            steps.appendChild(
              h(
                'div',
                'wds-step',
                h('span', 'wds-step-num', String(index + 1)),
                h('div', '', h('div', 'wds-step-title', pair[0]), h('div', 'wds-step-desc', pair[1])),
              ),
            )
          })

          // 能力地图
          const feats = h('div', 'wds-feat-grid')
          const featData = [
            ['plug', t.guide.feat1Title, t.guide.feat1Desc],
            ['book', t.guide.feat2Title, t.guide.feat2Desc],
            ['db', t.guide.feat3Title, t.guide.feat3Desc],
            ['activity', t.guide.feat4Title, t.guide.feat4Desc],
          ]
          for (const feat of featData) {
            feats.appendChild(
              h(
                'div',
                'wds-feat',
                h('span', 'wds-feat-icon', icon(feat[0], 16)),
                h('div', 'wds-feat-title', feat[1]),
                h('div', 'wds-feat-desc', feat[2]),
              ),
            )
          }

          // 同步规则
          const defs = h('dl', 'wds-defs')
          const ruleData = [
            [t.guide.ruleUpload, t.guide.ruleUploadDesc],
            [t.guide.ruleDownload, t.guide.ruleDownloadDesc],
            [t.guide.ruleMerge, t.guide.ruleMergeDesc],
            [t.guide.ruleSkip, t.guide.ruleSkipDesc],
            [t.guide.ruleDelete, t.guide.ruleDeleteDesc],
          ]
          for (const rule of ruleData) {
            defs.append(h('div', 'wds-def', h('dt', '', rule[0]), h('dd', '', rule[1])))
          }

          // 兼容性
          const table = h('table', 'wds-table')
          const thead = h('thead', '', h('tr', '', h('th', '', t.guide.compatServer), h('th', '', t.guide.compatNote)))
          const tbody = h('tbody', '')
          const compatData = [
            [t.guide.compat1, t.guide.compat1Desc],
            [t.guide.compat2, t.guide.compat2Desc],
            [t.guide.compat3, t.guide.compat3Desc],
            [t.guide.compat4, t.guide.compat4Desc],
            [t.guide.compat5, t.guide.compat5Desc],
          ]
          for (const row of compatData) tbody.appendChild(h('tr', '', h('td', '', row[0]), h('td', '', row[1])))
          table.append(thead, tbody)

          // 安全
          const secGrid = h('div', 'wds-feat-grid')
          const secData = [
            ['shield', t.guide.sec1Title, t.guide.sec1Desc],
            ['lock', t.guide.sec2Title, t.guide.sec2Desc],
            ['cpu', t.guide.sec3Title, t.guide.sec3Desc],
          ]
          for (const item of secData) {
            secGrid.appendChild(
              h(
                'div',
                'wds-feat',
                h('span', 'wds-feat-icon', icon(item[0], 16)),
                h('div', 'wds-feat-title', item[1]),
                h('div', 'wds-feat-desc', item[2]),
              ),
            )
          }

          // FAQ
          const faqWrap = h('div', '')
          const faqData = [
            [t.guide.faq1q, t.guide.faq1a],
            [t.guide.faq2q, t.guide.faq2a],
            [t.guide.faq3q, t.guide.faq3a],
            [t.guide.faq4q, t.guide.faq4a],
            [t.guide.faq5q, t.guide.faq5a],
            [t.guide.faq6q, t.guide.faq6a],
          ]
          for (const faq of faqData) {
            faqWrap.appendChild(h('details', 'wds-faq', h('summary', '', faq[0]), h('p', 'wds-faq-body', faq[1])))
          }

          // 关于
          const aboutKv = h('dl', 'wds-kv')
          const aboutRows = {
            version: h('dd', '', '—'),
            machine: h('dd', '', '—'),
            dataDir: h('dd', '', '—'),
            remote: h('dd', '', '—'),
            profile: h('dd', '', '—'),
          }
          aboutKv.append(
            h('dt', '', t.guide.aboutVersion),
            aboutRows.version,
            h('dt', '', t.guide.aboutMachine),
            aboutRows.machine,
            h('dt', '', t.guide.aboutDataDir),
            aboutRows.dataDir,
            h('dt', '', t.guide.aboutRemote),
            aboutRows.remote,
            h('dt', '', t.guide.aboutProfile),
            aboutRows.profile,
          )

          node.append(
            heroCard,
            card(t.guide.quickTitle, null, steps),
            card(t.guide.featTitle, null, feats),
            card(t.guide.rulesTitle, null, defs),
            card(t.guide.compatTitle, null, table),
            card(t.guide.securityTitle, null, secGrid),
            card(t.guide.faqTitle, null, faqWrap),
            card(t.guide.aboutTitle, t.guide.aboutDocs, aboutKv),
          )

          function fill() {
            const cfg = state.config
            const status = state.status
            const env = (cfg && cfg.env) || (status && status.env) || {}
            aboutRows.version.textContent = (cfg && cfg.version) || (env && env.dshVersion) || '—'
            aboutRows.machine.textContent = (cfg && cfg.machineId) || (status && status.machineId) || '—'
            aboutRows.dataDir.textContent = (env && env.dshHome) || t.diag.notFound
            aboutRows.remote.textContent = (cfg && cfg.options && cfg.options.remoteRoot) || '—'
            aboutRows.profile.textContent =
              ((cfg && cfg.profile) || (env && env.profile) || '—') + (env && env.generation ? ' · ' + env.generation : '')
          }

          return { node, onShow: fill, render: fill }
        }

        // ================================================================ 连接
        function fbox(labelText, control, hint) {
          return h(
            'div',
            'wds-field',
            labelText ? h('span', 'wds-label', labelText) : null,
            control,
            hint ? h('span', 'wds-hint', hint) : null,
          )
        }

        function buildConnect() {
          const node = h('div', 'wds-pane')

          const url = input('text', '', t.connect.urlHint)
          const user = input('text', '', '')
          const pass = input('password', '', t.connect.passwordHint)
          const timeout = input('number', '30000', '30000')
          const remoteRoot = input('text', '/dsh-sync/', '/dsh-sync/')
          const tls = switchRow(t.connect.tls, t.connect.tlsHint, false)
          const passState = h('div', 'wds-hint', '')

          const advanced = h(
            'div',
            '',
            h(
              'div',
              'wds-grid-2',
              fbox(t.connect.timeout, timeout),
              fbox(t.connect.remoteRoot, remoteRoot),
            ),
            h('div', '', tls),
          )
          advanced.style.display = 'none'
          const advToggle = button('▸ ' + t.connect.advanced, 'ghost')
          advToggle.setAttribute('aria-expanded', 'false')
          advToggle.onclick = () => {
            const hidden = advanced.style.display === 'none'
            advanced.style.display = hidden ? 'block' : 'none'
            advToggle.textContent = (hidden ? '▾ ' : '▸ ') + t.connect.advanced
            advToggle.setAttribute('aria-expanded', hidden ? 'true' : 'false')
          }

          const testBtn = button('')
          const testLabel = h('span', '', t.connect.test)
          testBtn.append(icon('plug', 14), testLabel)
          const saveBtn = button(t.action.save, 'primary')
          const saveStatus = statusBox(null)
          const testBox = h('div', '')

          const basicCard = card(
            null,
            null,
            fbox(t.connect.url, url),
            h('div', 'wds-grid-2', fbox(t.connect.username, user), fbox(t.connect.password, pass, t.connect.passwordHint)),
            passState,
            h('div', 'wds-actions', advToggle),
            advanced,
            h('div', 'wds-actions', testBtn, saveBtn),
            testBox,
            saveStatus.node,
          )

          const securityCard = card(
            t.guide.securityTitle,
            null,
            h(
              'div',
              'wds-defs',
              h('div', 'wds-def', h('dt', '', t.guide.sec1Title), h('dd', '', t.guide.sec1Desc)),
              h('div', 'wds-def', h('dt', '', t.guide.sec2Title), h('dd', '', t.guide.sec2Desc)),
            ),
          )

          node.append(basicCard, securityCard)

          function renderTestResult(result) {
            clearNode(testBox)
            if (!result) return
            const caps = result.capabilities || {}
            const stepLabels = {
              propfind: t.connect.stepPropfind,
              mkcol: t.connect.stepMkcol,
              put: t.connect.stepPut,
              readback: t.connect.stepReadback,
            }
            const chips = h('div', 'wds-chips')
            for (const step of result.steps || []) {
              const label = stepLabels[step.step] || step.step
              const node2 = h('span', 'wds-chip', h('span', 'wds-dot'), label + ' · ' + (step.ok ? '✓' : '✗'))
              node2.dataset.tone = step.ok ? 'ok' : 'err'
              chips.appendChild(node2)
            }
            if (caps.server) {
              chips.appendChild(h('span', 'wds-chip', t.connect.server + ' · ' + caps.server))
            }
            chips.appendChild(
              h('span', 'wds-chip', t.connect.capsLock + ' · ' + (caps.supportsLock ? t.connect.capsYes : t.connect.capsNo)),
            )
            chips.appendChild(
              h('span', 'wds-chip', t.connect.capsIf + ' · ' + (caps.supportsIfHeader ? t.connect.capsYes : t.connect.capsNo)),
            )

            testBox.appendChild(h('div', 'wds-eyebrow', t.connect.steps))
            testBox.appendChild(chips)

            if (result.ok) {
              testBox.appendChild(note('ok', t.connect.ok))
            } else {
              const failed = (result.steps || []).filter((step) => !step.ok)
              const codes = []
              for (const step of failed) {
                const code = String(step.detail || '').replace(/^HTTP\s+/, '').trim()
                if (code && codes.indexOf(code) === -1) codes.push(code)
              }
              const hints = []
              for (const code of codes) {
                const hint = t.connect['http' + code]
                if (hint) hints.push(hint)
              }
              const message =
                t.connect.fail +
                (failed.length ? ' — ' + failed.map((step) => (stepLabels[step.step] || step.step) + ' ' + step.detail).join(' · ') : '') +
                (hints.length ? '\n' + hints.join('\n') : '')
              testBox.appendChild(note('err', message))
            }
          }

          testBtn.onclick = async () => {
            testBtn.disabled = true
            testLabel.textContent = t.connect.testing
            saveStatus.clear()
            clearNode(testBox)
            try {
              const result = await api('/test', {
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
              renderTestResult(result)
              if (result && result.ok) {
                saveStatus.show('ok', t.connect.ok)
                // 测试通过顺手保存，避免用户忘点保存后又来问为什么同步说未配置
                await persist()
              } else {
                saveStatus.show('err', t.connect.fail)
              }
            } catch (err) {
              saveStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              testBtn.disabled = false
              testLabel.textContent = t.connect.test
            }
          }

          async function persist() {
            const saved = await api('/config', {
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
            state.config = saved
            fill(saved)
            renderPill()
            return saved
          }

          saveBtn.onclick = async () => {
            saveBtn.disabled = true
            try {
              await persist()
              saveStatus.show('ok', t.action.saved)
              if (panes.mode.fill) panes.mode.fill(state.config)
            } catch (err) {
              saveStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              saveBtn.disabled = false
            }
          }

          function fill(cfg) {
            if (!cfg) return
            const conn = cfg.connection || {}
            url.value = conn.url || ''
            user.value = conn.username || ''
            pass.value = ''
            const opts = cfg.options || {}
            timeout.value = String(opts.timeoutMs || 30000)
            remoteRoot.value = opts.remoteRoot || '/dsh-sync/'
            tls.input.checked = opts.ignoreTlsErrors === true
            passState.textContent = conn.hasPassword ? '● ' + t.connect.hasPassword : '○ ' + t.connect.noPassword
            passState.style.color = conn.hasPassword ? 'var(--wds-ok)' : 'var(--wds-muted)'
          }

          function fail(message) {
            saveStatus.show('err', message)
          }

          return { node, fill, fail }
        }

        // ================================================================ 内容
        function buildScope() {
          const node = h('div', 'wds-pane')

          const groups = [
            { key: 'bundles', label: t.scope.bundles, kind: 'bundles' },
            { key: 'skills', label: t.scope.skills, kind: 'skills' },
            { key: 'configs', label: t.scope.configs, kind: 'configs' },
          ]

          const scopeState = {
            bundles: { mode: 'all', exclude: [] },
            skills: { mode: 'all', exclude: [] },
            configs: { mode: 'none', includeKeys: [] },
          }
          const itemsCache = { bundles: null, skills: null, configs: null }
          const builders = []

          for (const group of groups) {
            const rows = h('div', 'wds-rows')
            const countText = h('span', 'wds-card-sub', '')
            const modeSeg = segmented(
              [
                ['all', t.scope.all],
                ['selected', t.scope.selected],
                ['none', t.scope.none],
              ],
              scopeState[group.key].mode,
              (value) => {
                scopeState[group.key].mode = value
                void renderRows()
              },
            )
            const editor = chipEditor(
              group.key === 'configs' ? scopeState.configs.includeKeys : scopeState[group.key].exclude,
              (values) => {
                if (group.key === 'configs') scopeState.configs.includeKeys = values.slice()
                else scopeState[group.key].exclude = values.slice()
              },
            )

            const children = [
              h(
                'div',
                'wds-card-head',
                h('div', 'wds-card-head-text', h('h3', 'wds-card-title', group.label), countText),
                modeSeg,
              ),
              rows,
              h('div', 'wds-eyebrow', group.key === 'configs' ? t.scope.includeKeys : t.scope.exclude),
              editor.node,
              editor.hint,
            ]
            if (group.key === 'configs') children.push(note('warn', t.scope.configsTip))
            const groupCard = h('section', 'wds-card', ...children)

            const groupMeta = {
              key: group.key,
              rows,
              modeSeg,
              countText,
              editor,
              renderRows: () => renderRows(),
            }
            builders.push(groupMeta)

            node.appendChild(groupCard)

            async function renderRows() {
              const mode = scopeState[group.key].mode
              countText.textContent = t.scope.loading
              let items = itemsCache[group.key]
              if (!items) {
                try {
                  items = await api('/items?kind=' + group.key)
                  itemsCache[group.key] = Array.isArray(items) ? items : []
                } catch (err) {
                  items = []
                }
              }
              clearNode(rows)
              const excluded = new Set(scopeState[group.key].exclude || [])
              if (!items.length) {
                rows.appendChild(emptyState('list', t.scope.empty, ''))
                countText.textContent = '0'
                return
              }
              let checkedCount = 0
              for (const item of items) {
                const box = document.createElement('input')
                box.type = 'checkbox'
                box.checked = mode === 'all' ? true : mode === 'none' ? false : !excluded.has(item.name)
                box.disabled = mode !== 'selected'
                box.onchange = () => {
                  const next = new Set(scopeState[group.key].exclude || [])
                  if (box.checked) next.delete(item.name)
                  else next.add(item.name)
                  scopeState[group.key].exclude = [...next]
                  editor.setValues(scopeState[group.key].exclude)
                  void renderRows()
                }
                if (box.checked) checkedCount += 1
                rows.appendChild(
                  h(
                    'div',
                    'wds-row',
                    box,
                    h(
                      'div',
                      'wds-row-main',
                      h('div', 'wds-row-name', item.name),
                      h('div', 'wds-row-reason', item.version ? 'v' + item.version : item.kind || ''),
                    ),
                    item.sizeBytes ? h('span', 'wds-row-extra', formatBytes(item.sizeBytes)) : null,
                  ),
                )
              }
              countText.textContent = fillTemplate(t.scope.selectedCount, { n: checkedCount, total: items.length })
            }
          }

          const saveBtn = button(t.scope.save, 'primary')
          const saveStatus = statusBox(null)
          const actions = h('div', 'wds-actions', saveBtn)
          node.append(actions, saveStatus.node)

          saveBtn.onclick = async () => {
            saveBtn.disabled = true
            try {
              // 只发该组真正拥有的字段：bundles/skills 用 exclude，configs 用 includeKeys
              const payload = {}
              for (const group of groups) {
                const current = scopeState[group.key]
                payload[group.key] =
                  group.key === 'configs'
                    ? { mode: current.mode, includeKeys: current.includeKeys.slice() }
                    : { mode: current.mode, exclude: current.exclude.slice() }
              }
              const saved = await api('/config', { method: 'POST', body: { scope: payload } })
              state.config = saved
              saveStatus.show('ok', t.action.saved)
            } catch (err) {
              saveStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              saveBtn.disabled = false
            }
          }

          function fill(cfg) {
            if (!cfg) return
            const scope = cfg.scope || {}
            for (const group of groups) {
              const value = scope[group.key] || {}
              const mode = value.mode || (group.key === 'configs' ? 'none' : 'all')
              scopeState[group.key] = {
                mode,
                exclude: Array.isArray(value.exclude) ? value.exclude.slice() : [],
                includeKeys: Array.isArray(value.includeKeys) ? value.includeKeys.slice() : [],
              }
              const meta = builders.find((entry) => entry.key === group.key)
              if (!meta) continue
              meta.modeSeg.setValue(mode)
              meta.editor.setValues(group.key === 'configs' ? scopeState.configs.includeKeys : scopeState[group.key].exclude)
            }
            for (const meta of builders) void meta.renderRows()
          }

          return {
            node,
            fill,
            onShow: () => {
              itemsCache.bundles = null
              itemsCache.skills = null
              itemsCache.configs = null
              for (const meta of builders) void meta.renderRows()
            },
          }
        }

        /** 标签编辑器：输入框回车/逗号提交，标签可点 × 删除 */
        function chipEditor(initial, onChange) {
          const values = Array.isArray(initial) ? initial.slice() : []
          const list = h('div', 'wds-chips')
          const entry = input('text', '', t.scope.addChip)
          entry.className = 'wds-input'
          const node = h('div', 'wds-chips-editor', list, entry)
          const hint = h('span', 'wds-hint', t.scope.chipHint)

          function commit() {
            const parts = splitList(entry.value)
            let changed = false
            for (const part of parts) {
              if (values.indexOf(part) === -1) {
                values.push(part)
                changed = true
              }
            }
            entry.value = ''
            if (changed) {
              render()
              if (onChange) onChange(values.slice())
            }
          }

          function render() {
            clearNode(list)
            if (!values.length) {
              list.appendChild(h('span', 'wds-hint', '—'))
              return
            }
            values.forEach((value, index) => {
              const remove = h('button', 'wds-chip-x', '×')
              remove.type = 'button'
              remove.setAttribute('aria-label', t.common.close)
              remove.onclick = () => {
                values.splice(index, 1)
                render()
                if (onChange) onChange(values.slice())
              }
              list.appendChild(h('span', 'wds-chip', value, remove))
            })
          }

          entry.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && entry.value === '' && values.length) {
              values.pop()
              render()
              if (onChange) onChange(values.slice())
            }
          }
          entry.onblur = () => commit()

          render()
          return {
            node,
            hint,
            setValues: (next) => {
              values.length = 0
              for (const item of next || []) values.push(item)
              render()
            },
            getValues: () => values.slice(),
          }
        }

        // ================================================================ 方式
        function buildMode() {
          const node = h('div', 'wds-pane')

          const direction = segmented(
            [
              ['both', t.mode.both],
              ['upload', t.mode.upload],
              ['download', t.mode.download],
            ],
            'both',
          )
          const schedule = switchRow(t.mode.schedule, t.mode.scheduleHint, false)
          const interval = input('number', '1', '1')
          interval.min = '0.5'
          interval.step = '0.5'
          const policy = select(
            [
              ['auto', t.mode.policyAuto],
              ['merge-backup', t.mode.policyMergeBackup],
              ['ask', t.mode.policyAsk],
              ['local-wins', t.mode.policyLocal],
              ['remote-wins', t.mode.policyRemote],
            ],
            'auto',
          )
          const policyHint = h('div', 'wds-hint', t.mode.policyAutoHint)
          policy.onchange = () => {
            const map = {
              auto: t.mode.policyAutoHint,
              'merge-backup': t.mode.policyMergeBackup,
              ask: t.mode.policyAsk,
              'local-wins': t.mode.policyLocal,
              'remote-wins': t.mode.policyRemote,
            }
            policyHint.textContent = map[policy.value] || ''
          }

          const smart = {
            propagateDeletions: switchRow(t.mode.propagate, t.mode.propagateHint, true),
            dedupeRemote: switchRow(t.mode.dedupe, t.mode.dedupeHint, true),
            autoInstall: switchRow(t.mode.autoInstall, t.mode.autoInstallHint, true),
            contentMerge: switchRow(t.mode.contentMerge, t.mode.contentMergeHint, true),
            pruneTombstones: switchRow(t.mode.prune, t.mode.pruneHint, true),
          }
          const maxBackups = input('number', '10', '10')
          maxBackups.min = '1'
          maxBackups.max = '100'

          const saveBtn = button(t.mode.save, 'primary')
          const saveStatus = statusBox(null)

          const directionCard = card(
            t.mode.direction,
            t.mode.directionHint,
            fbox('', direction),
            schedule,
            h('div', 'wds-grid-2', fbox(t.mode.interval, interval)),
          )
          const policyCard = card(
            t.mode.conflictPolicy,
            null,
            fbox('', policy),
            policyHint,
            h('div', 'wds-grid-2', fbox(t.mode.maxBackups, maxBackups)),
          )
          const smartCard = card(
            t.mode.smartTitle,
            null,
            smart.propagateDeletions,
            smart.dedupeRemote,
            smart.autoInstall,
            smart.contentMerge,
            smart.pruneTombstones,
          )

          node.append(directionCard, policyCard, smartCard, h('div', 'wds-actions', saveBtn), saveStatus.node)

          saveBtn.onclick = async () => {
            saveBtn.disabled = true
            try {
              const saved = await api('/config', {
                method: 'POST',
                body: {
                  schedule: {
                    enabled: schedule.input.checked,
                    intervalHours: Math.max(0.5, Number(interval.value) || 1),
                    direction: direction.getValue(),
                  },
                  conflictPolicy: policy.value,
                  syncOptions: {
                    propagateDeletions: smart.propagateDeletions.input.checked,
                    dedupeRemote: smart.dedupeRemote.input.checked,
                    autoInstall: smart.autoInstall.input.checked,
                    contentMerge: smart.contentMerge.input.checked,
                    pruneTombstones: smart.pruneTombstones.input.checked,
                    maxBackups: Math.max(1, Math.min(100, Number(maxBackups.value) || 10)),
                  },
                },
              })
              state.config = saved
              fill(saved)
              saveStatus.show('ok', t.action.saved)
              renderPill()
            } catch (err) {
              saveStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              saveBtn.disabled = false
            }
          }

          function fill(cfg) {
            if (!cfg) return
            const sched = cfg.schedule || {}
            direction.setValue(sched.direction || 'both')
            schedule.input.checked = sched.enabled === true
            interval.value = String(sched.intervalHours || 1)
            policy.value = cfg.conflictPolicy || 'auto'
            policy.onchange()
            const opts = cfg.syncOptions || {}
            smart.propagateDeletions.input.checked = opts.propagateDeletions !== false
            smart.dedupeRemote.input.checked = opts.dedupeRemote !== false
            smart.autoInstall.input.checked = opts.autoInstall !== false
            smart.contentMerge.input.checked = opts.contentMerge !== false
            smart.pruneTombstones.input.checked = opts.pruneTombstones !== false
            maxBackups.value = String(opts.maxBackups || 10)
          }

          return { node, fill }
        }

        // ================================================================ 日志
        function buildLogs() {
          const node = h('div', 'wds-pane')

          const filterDefs = [
            ['all', t.logs.filterAll],
            ['ok', t.logs.filterOk],
            ['fail', t.logs.filterFail],
            ['merge', t.logs.filterMerge],
            ['skip', t.logs.filterSkip],
            ['delete', t.logs.filterDelete],
          ]
          const filterBar = h('div', 'wds-chips')
          const filterButtons = {}
          for (const def of filterDefs) {
            const node2 = h('button', 'wds-chip wds-filter', def[1])
            node2.type = 'button'
            node2.dataset.active = def[0] === state.logFilter ? 'true' : 'false'
            node2.onclick = () => {
              state.logFilter = def[0]
              render()
            }
            filterButtons[def[0]] = node2
            filterBar.appendChild(node2)
          }

          const search = input('search', '', t.logs.search)
          search.className = 'wds-input wds-log-search'
          search.oninput = () => {
            state.logQuery = search.value.trim().toLowerCase()
            render()
          }

          const refreshBtn = iconButton('refresh', t.action.refresh, 'ghost')
          refreshBtn.onclick = () => void loadLogs()
          const exportBtn = iconButton('downloadBox', t.action.export, 'ghost')
          exportBtn.onclick = () => void exportLogs()

          const autoRow = switchRow(t.logs.autoRefresh, null, state.autoRefresh)
          autoRow.input.onchange = () => {
            state.autoRefresh = autoRow.input.checked
          }

          const countText = h('div', 'wds-card-sub', '')
          const list = h('div', 'wds-log-list')
          const noteSlot = h('div', '')
          const toolbar = h('div', 'wds-log-toolbar', filterBar, search, refreshBtn, exportBtn)

          node.append(card(t.logs.title, null, toolbar, autoRow, noteSlot, list, countText))

          function filtered() {
            const query = state.logQuery
            const filter = state.logFilter
            const out = []
            for (const entry of state.logs) {
              if (filter === 'ok') {
                if (entry.level !== 'success') continue
              } else if (filter === 'fail') {
                if (entry.level !== 'error' && entry.level !== 'warn') continue
              } else if (filter === 'merge') {
                if (entry.category !== 'merge' && entry.category !== 'dedupe') continue
              } else if (filter === 'skip') {
                if (entry.category !== 'skip') continue
              } else if (filter === 'delete') {
                if (entry.category !== 'delete' && entry.category !== 'prune') continue
              }
              if (query) {
                const haystack = ((entry.name || '') + ' ' + (entry.message || '') + ' ' + (entry.detail || '')).toLowerCase()
                if (haystack.indexOf(query) === -1) continue
              }
              out.push(entry)
            }
            return out
          }

          function render() {
            for (const key of Object.keys(filterButtons)) {
              filterButtons[key].dataset.active = key === state.logFilter ? 'true' : 'false'
            }
            clearNode(noteSlot)
            if (!state.supports.logs) noteSlot.appendChild(note('warn', t.logs.notSupported))

            clearNode(list)
            const entries = filtered().slice(0, LOG_RENDER_LIMIT)
            if (!entries.length) {
              list.appendChild(
                emptyState(
                  'list',
                  state.logs.length ? t.logs.noMatch : t.logs.empty,
                  state.logs.length ? '' : t.logs.notSupported,
                ),
              )
              countText.textContent = ''
              return
            }
            for (const entry of entries) {
              const levelTone = entry.level === 'success' ? 'ok' : entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : 'idle'
              const body = h(
                'div',
                'wds-log-body',
                h(
                  'div',
                  'wds-log-head',
                  badge(t.cat[entry.category] || entry.category || t.cat.system, levelTone === 'idle' ? '' : levelTone),
                  entry.name ? h('span', 'wds-log-name', entry.name) : null,
                ),
                h('div', 'wds-log-msg', entry.message || ''),
                entry.detail ? h('div', 'wds-log-detail', entry.detail) : null,
              )
              list.appendChild(h('div', 'wds-log-row', h('span', 'wds-log-time', formatClock(entry.at)), body))
            }
            countText.textContent = fillTemplate(t.logs.showing, { n: entries.length })
          }

          async function exportLogs() {
            const entries = filtered()
            const text = entries
              .map(
                (entry) =>
                  entry.at +
                  ' [' +
                  (entry.level || 'info') +
                  '/' +
                  (entry.category || 'system') +
                  '] ' +
                  (entry.name ? entry.name + ': ' : '') +
                  (entry.message || '') +
                  (entry.detail ? ' | ' + entry.detail : ''),
              )
              .join('\n')
            let ok = false
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text)
                ok = true
              }
            } catch (err) {
              ok = false
            }
            if (!ok) {
              try {
                const area = document.createElement('textarea')
                area.value = text
                area.style.position = 'fixed'
                area.style.opacity = '0'
                document.body.appendChild(area)
                area.select()
                ok = document.execCommand('copy')
                document.body.removeChild(area)
              } catch (err) {
                ok = false
              }
            }
            clearNode(noteSlot)
            noteSlot.appendChild(note(ok ? 'ok' : 'err', ok ? t.logs.exportDone : t.logs.exportFail))
          }

          render()
          return {
            node,
            render,
            onShow: () => {
              render()
              void loadLogs()
            },
            reload: () => void loadLogs(),
          }
        }

        // ================================================================ 诊断
        function buildDiag() {
          const node = h('div', 'wds-pane')

          const envKv = h('dl', 'wds-kv')
          const envCard = card(t.diag.envTitle, null, envKv)

          const lockText = h('div', 'wds-hint', '')
          const capsText = h('div', 'wds-chips')
          const reprobeBtn = iconButton('refresh', t.action.reprobe)
          const diagStatus = statusBox(null)
          const capsCard = h(
            'section',
            'wds-card',
            h('div', 'wds-card-head', h('div', 'wds-card-head-text', h('h3', 'wds-card-title', t.diag.lockTitle))),
            lockText,
            h('div', 'wds-eyebrow', t.diag.capsTitle),
            capsText,
            h('div', 'wds-actions', reprobeBtn),
            diagStatus.node,
          )

          // 危险区
          const resetBtn = button(t.diag.resetTitle, 'danger')
          let resetArmed = false
          let resetTimer = null
          const resetHint = h('div', 'wds-hint', t.diag.resetDesc)
          resetBtn.onclick = async () => {
            if (!resetArmed) {
              resetArmed = true
              resetBtn.textContent = t.diag.resetArmed
              resetHint.textContent = t.diag.resetConfirm
              resetTimer = setTimeout(() => {
                resetArmed = false
                resetBtn.textContent = t.diag.resetTitle
                resetHint.textContent = t.diag.resetDesc
              }, 5000)
              return
            }
            if (resetTimer) clearTimeout(resetTimer)
            resetArmed = false
            resetBtn.disabled = true
            try {
              await api('/reset', { method: 'POST' })
              diagStatus.show('ok', t.action.saved)
              await loadConfig()
              await loadStatus()
            } catch (err) {
              diagStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              resetBtn.disabled = false
              resetBtn.textContent = t.diag.resetTitle
              resetHint.textContent = t.diag.resetDesc
            }
          }

          const clearInput = input('text', '', t.diag.clearPlaceholder)
          const clearBtn = button(t.diag.clearTitle, 'danger')
          clearBtn.disabled = true
          clearInput.oninput = () => {
            clearBtn.disabled = clearInput.value.trim().toUpperCase() !== 'DELETE'
          }
          clearBtn.onclick = async () => {
            if (clearInput.value.trim().toUpperCase() !== 'DELETE') return
            clearBtn.disabled = true
            try {
              const result = await api('/clear-remote', { method: 'POST' })
              diagStatus.show('ok', t.diag.clearTitle + ' · ' + ((result && result.removed) || 0))
              clearInput.value = ''
            } catch (err) {
              diagStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              clearBtn.disabled = clearInput.value.trim().toUpperCase() !== 'DELETE'
            }
          }

          const dangerCard = h(
            'section',
            'wds-card wds-card--danger',
            h(
              'div',
              'wds-card-head',
              h('div', 'wds-card-head-text', h('h3', 'wds-card-title', t.diag.dangerTitle)),
            ),
            h('div', 'wds-defs', h('div', 'wds-def', h('dt', '', t.diag.resetTitle), h('dd', '', t.diag.resetDesc))),
            h('div', 'wds-actions', resetBtn),
            resetHint,
            h('div', 'wds-defs', h('div', 'wds-def', h('dt', '', t.diag.clearTitle), h('dd', '', t.diag.clearDesc))),
            h('div', 'wds-grid-2', fbox('', clearInput)),
            h('div', 'wds-actions', clearBtn),
          )

          node.append(envCard, capsCard, dangerCard)

          reprobeBtn.onclick = async () => {
            reprobeBtn.disabled = true
            try {
              const env = await api('/reprobe', { method: 'POST' })
              renderEnv(env)
              diagStatus.show('ok', t.action.reprobe)
            } catch (err) {
              diagStatus.show('err', t.common.error + ': ' + err.message)
            } finally {
              reprobeBtn.disabled = false
            }
          }

          function renderEnv(env) {
            const resolved = env || (state.status && state.status.env) || {}
            clearNode(envKv)
            const rows = [
              [t.diag.dsh, resolved.dshVersion || t.diag.notFound],
              [t.diag.profile, (resolved.profile || t.diag.notFound) + ' · ' + (resolved.generation || '?')],
              [t.diag.home, resolved.dshHome || t.diag.notFound],
              [t.diag.profileDir, resolved.profileDir || '—'],
              [t.diag.skillsDir, resolved.skillsDir || '—'],
              [t.diag.settings, resolved.settingsFile || t.diag.notFound],
            ]
            for (const row of rows) envKv.append(h('dt', '', row[0]), h('dd', '', row[1]))
          }

          function fillConfig(cfg) {
            void cfg
            renderEnv(null)
          }

          function fillStatus(status) {
            if (!status) return
            renderEnv(status.env)
            const lock = status.lock
            lockText.textContent = lock && lock.machineId
              ? fillTemplate(t.diag.lockHeld, { machine: lock.machineId, time: formatTime(lock.expiresAt, locale) })
              : t.diag.lockFree
            clearNode(capsText)
            const caps = status.capabilities
            if (!caps) {
              capsText.appendChild(h('span', 'wds-chip', t.diag.notFound))
            } else {
              if (caps.server) capsText.appendChild(h('span', 'wds-chip', t.connect.server + ' · ' + caps.server))
              const lockChip = h('span', 'wds-chip', t.connect.capsLock + ' · ' + (caps.supportsLock ? t.connect.capsYes : t.connect.capsNo))
              lockChip.dataset.tone = caps.supportsLock ? 'ok' : 'warn'
              capsText.appendChild(lockChip)
              const ifChip = h('span', 'wds-chip', t.connect.capsIf + ' · ' + (caps.supportsIfHeader ? t.connect.capsYes : t.connect.capsNo))
              ifChip.dataset.tone = caps.supportsIfHeader ? 'ok' : 'warn'
              capsText.appendChild(ifChip)
            }
          }

          return { node, fillConfig, fillStatus, onShow: () => fillStatus(state.status) }
        }

        // ---------------- 初始加载 ----------------
        void (async () => {
          await loadConfig()
          await loadStatus()
          await loadProgress()
          await loadLogs()
        })()

        return () => {
          stopPolling()
        }
      }

      cleanup = boot()
      if (options.subscribeLocale) {
        unsubLocale = options.subscribeLocale(() => {
          if (disposed) return
          try {
            if (cleanup) cleanup()
          } catch (err) {
            /* 旧一轮清理失败不影响重挂载 */
          }
          cleanup = boot()
        })
      }

      return () => {
        disposed = true
        if (unsubLocale) {
          try {
            unsubLocale()
          } catch (err) {
            /* ignore */
          }
          unsubLocale = null
        }
        try {
          if (cleanup) cleanup()
        } catch (err) {
          /* ignore */
        }
        cleanup = null
        clearNode(root)
      }
    }

    /** 冲突策略 → i18n key 后缀 */
    function policyKey(policy) {
      if (policy === 'auto') return 'Auto'
      if (policy === 'ask') return 'Ask'
      if (policy === 'local-wins') return 'Local'
      if (policy === 'remote-wins') return 'Remote'
      return 'MergeBackup'
    }

    // ------------------------------------------------------------- React 薄壳

    const LOCALE = { zh: flattenDict(i18n.zh), en: flattenDict(i18n.en) }

    function fallbackLocale() {
      const lang = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh').toLowerCase()
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    const FALLBACK_TRANSPORT = {
      getLocale: fallbackLocale,
      subscribeLocale: () => () => {},
    }

    function WebDavSyncPanel(props) {
      const ref = React.useRef(null)
      const config = props || {}
      const variant = config.variant || 'page'
      const transport = config.transport || FALLBACK_TRANSPORT
      React.useEffect(() => {
        const element = ref.current
        if (!element) return undefined
        let dispose = null
        try {
          dispose = mount(element, {
            variant,
            getLocale: transport.getLocale,
            subscribeLocale: transport.subscribeLocale,
          })
        } catch (err) {
          // 面板挂载失败不能静默：留下可诊断的一行
          console.error('[dsh-webdav-enhanced] panel mount failed', err)
        }
        return () => {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch (err) {
              console.error('[dsh-webdav-enhanced] panel dispose failed', err)
            }
          }
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
              let dispose = null
              try {
                dispose = fn()
              } catch (err) {
                console.error('[dsh-webdav-enhanced] effect failed', err)
              }
              return () => {
                if (typeof dispose === 'function') {
                  try {
                    dispose()
                  } catch (err) {
                    /* ignore */
                  }
                }
              }
            }

      const localeService = () => {
        try {
          return ctx.locale || null
        } catch (err) {
          return null
        }
      }

      const transport = {
        getLocale: () => {
          try {
            const service = localeService()
            const snapshot = service && typeof service.getSnapshot === 'function' ? service.getSnapshot() : null
            const active = snapshot && (snapshot.active || snapshot.locale)
            if (active) return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
          } catch (err) {
            /* 回退到浏览器语言 */
          }
          return fallbackLocale()
        },
        subscribeLocale: (fn) => {
          try {
            const service = localeService()
            if (service && typeof service.subscribe === 'function') {
              const dispose = service.subscribe(fn)
              return () => {
                if (typeof dispose === 'function') dispose()
              }
            }
          } catch (err) {
            /* 忽略：没有订阅能力时语言切换后重开面板即可 */
          }
          return () => {}
        },
      }

      // 词典注册是「加分项」：宿主允许注册就注册，重复注册抛错也不影响面板
      if (localeService() && typeof localeService().register === 'function') {
        effect(() => {
          try {
            const dispose = localeService().register(NS, LOCALE)
            return () => {
              if (typeof dispose === 'function') dispose()
            }
          } catch (err) {
            return undefined
          }
        }, NS + ': locale')
      }

      const slots = ctx.slots
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

      // 三个入口共用一个面板：
      //   1/2. 插件详情页（bundle 级 + row 级，旧版本页面可能只用其一）
      //   3.   设置弹窗左侧导航里的独立设置页
      const targets = [
        { slot: 'plugins.bundle.config', key: PKG, variant: 'page' },
        { slot: 'plugins.row.config', key: PKG + '#' + ROW_ID, variant: 'row' },
        { slot: 'settings.section', id: 'webdav-sync', order: 16, variant: 'settings' },
      ]

      for (const target of targets) {
        effect(() => {
          const disposeInject = slots.inject(target.slot, () => {
            const registration = { name: target.slot, locale: NS }
            if (target.key) registration.key = target.key
            if (target.id) {
              registration.id = target.id
              registration.order = target.order
              // label 必须是函数：切换语言时宿主每次投影都会重读
              registration.label = () => (transport.getLocale() === 'zh' ? 'WebDAV 同步' : 'WebDAV sync')
            }
            return slots.register(registration, () =>
              React.createElement(WebDavSyncPanel, { variant: target.variant, transport }),
            )
          })
          return () => {
            if (typeof disposeInject === 'function') disposeInject()
          }
        }, NS + ': ' + target.slot)
      }
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
