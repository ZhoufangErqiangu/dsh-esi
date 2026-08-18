/**
 * Locale dictionaries for the SDE-update settings card.
 * @module @dsh-esi/plugin-esi/client
 */

export type EveAccountLocaleKey =
  | 'accountTitle'
  | 'accountDescription'
  | 'charactersLabel'
  | 'noCharacters'
  | 'scopesCount'
  | 'expired'
  | 'deauth'
  | 'deauthAll'
  | 'login'
  | 'loginBusy'
  | 'openLoginUrl'
  | 'defaultRegionLabel'
  | 'defaultRegionHint'
  | 'noRegion'
  | 'comingSoon'
  | 'expand'
  | 'collapse'
  // oauth status line keys (host sends messageKey + messageParams)
  | 'status.idle.noCharacters'
  | 'status.idle.authorized'
  | 'status.starting'
  | 'status.waiting'
  | 'status.authorized'

export type SdeCardLocaleKey =
  | 'title'
  | 'description'
  | 'urlLabel'
  | 'urlPlaceholder'
  | 'urlHint'
  | 'update'
  | 'rollback'
  | 'rollbackHint'
  | 'unavailable'
  | 'busy'
  | 'invalidUrl'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'building'
  | 'installing'
  | 'done'
  | 'error'
  | 'noStatus'
  | 'noData'
  | 'officialDataLink'
  | 'expand'
  | 'collapse'
  // status line keys (host sends messageKey + messageParams; `{n}` interpolated client-side)
  | 'status.idle.noData'
  | 'status.idle.version'
  | 'status.checking'
  | 'status.probeReady'
  | 'status.probeReadySize'
  | 'status.probePassed'
  | 'status.probePassedSize'
  | 'status.downloading'
  | 'status.downloadingPercent'
  | 'status.extracting'
  | 'status.building'
  | 'status.installing'
  | 'status.rollingBack'
  | 'status.updated'
  | 'status.rolledBack'
  | 'status.rolledBackTo'
  // error line keys (client maps the host error code to one of these)
  | 'err.busy'
  | 'err.noRollback'
  | 'err.internal'
  | 'err.urlEmpty'
  | 'err.urlTooLong'
  | 'err.urlControlChar'
  | 'err.urlMalformed'
  | 'err.urlScheme'
  | 'err.urlNoHost'
  | 'err.httpError'
  | 'err.http404'
  | 'err.http403'
  | 'err.network'
  | 'err.timeout'
  | 'err.tooLarge'
  | 'err.tooLargeStream'
  | 'err.downloadEmpty'
  | 'err.downloadAborted'
  | 'err.zipBadMagic'
  | 'err.zipCorrupt'
  | 'err.zipEmpty'
  | 'err.zipBomb'
  | 'err.zipBombSize'
  | 'err.pathEmpty'
  | 'err.pathUnsafe'
  | 'err.pathTraversal'
  | 'err.payloadNoManifest'
  | 'err.payloadJsonInvalid'
  | 'err.payloadStructInvalid'
  | 'err.payloadNoBuild'
  | 'err.payloadNoTables'
  | 'err.payloadEmptyTables'
  | 'err.payloadMissingTables'
  | 'err.payloadMissingTablesMany'
  | 'err.diskFull'
  | 'err.diskDenied'
  | 'err.diskError'

export const zhAccount: Record<EveAccountLocaleKey, string> = {
  accountTitle: 'EVE 账号与市场',
  accountDescription: 'EVE SSO 登录授权，以及市场工具使用的默认星域',
  charactersLabel: '已授权角色',
  noCharacters: '未授权任何角色',
  scopesCount: '权限 {n}',
  expired: '（已过期）',
  deauth: '撤销',
  deauthAll: '撤销全部',
  login: '登录 EVE',
  loginBusy: '登录中…',
  openLoginUrl: '打开登录页',
  defaultRegionLabel: '默认市场星域',
  defaultRegionHint: '未设置时市场工具默认使用吉他（The Forge）；选择后立即生效。',
  noRegion: '未设置（默认吉他）',
  comingSoon: '即将推出（Coming Soon）',
  expand: '展开',
  collapse: '收起',
  'status.idle.noCharacters': '未授权任何角色',
  'status.idle.authorized': '已授权角色可正常使用',
  'status.starting': '正在启动 EVE 登录…',
  'status.waiting': '请在浏览器中打开链接完成 EVE 登录',
  'status.authorized': '已授权：{name}',
}

export const zh: Record<SdeCardLocaleKey, string> = {
  title: 'SDE 更新',
  description: '从下载地址更新 EVE 静态数据（SDE）；支持任意 http(s) 地址，压缩包需包含 manifest.json 与各表 .jsonl',
  urlLabel: '下载地址',
  urlPlaceholder: 'https://example.com/sde/sde-20260731-mirror.zip',
  urlHint: '仅支持 http/https 地址；建议先确认服务器可达。网络中断、地址无效、压缩包损坏都会在这里给出明确报错。',
  update: '下载并更新',
  rollback: '回滚',
  rollbackHint: '回滚到磁盘上保留的上一版本（更新失败可随时恢复）。',
  unavailable: 'dsh-esi 插件未加载：设置卡片需要插件在 host 端挂载后才能使用。',
  busy: '任务进行中…',
  invalidUrl: '请输入以 http:// 或 https:// 开头的完整下载地址',
  idle: '空闲',
  checking: '检查中',
  downloading: '下载中',
  extracting: '解压校验中',
  building: '构建索引中',
  installing: '切换版本中',
  done: '完成',
  error: '失败',
  noStatus: '等待状态…',
  noData: '尚未安装 SDE 数据',
  officialDataLink: '官方静态数据下载页（developers.eveonline.com/static-data）',
  expand: '展开',
  collapse: '收起',
  'status.idle.noData': '尚未安装 SDE 数据',
  'status.idle.version': '当前版本：build {build}',
  'status.checking': '正在检查下载地址…',
  'status.probeReady': '地址可访问，开始下载',
  'status.probeReadySize': '地址可访问，开始下载（{size}）',
  'status.probePassed': '检查通过：镜像 build {build}',
  'status.probePassedSize': '检查通过：镜像 build {build}（{size}）',
  'status.downloading': '正在下载 {size}',
  'status.downloadingPercent': '正在下载 {size}（{percent}%）',
  'status.extracting': '解压并校验数据…',
  'status.building': '正在构建索引（约 1 分钟）…',
  'status.installing': '正在切换版本…',
  'status.rollingBack': '正在回滚到 build {build}…',
  'status.updated': '更新完成：已切换到 build {build}',
  'status.rolledBack': '已回滚',
  'status.rolledBackTo': '已回滚到 build {build}',
  'err.busy': '已有更新任务在运行，请等待完成',
  'err.noRollback': '没有可回滚的旧版本',
  'err.internal': '更新失败：{detail}',
  'err.urlEmpty': '请输入下载地址',
  'err.urlTooLong': '下载地址过长（超过 {max} 字符）',
  'err.urlControlChar': '下载地址包含非法控制字符',
  'err.urlMalformed': '“{url}”不是有效的 URL；请输入完整的 http(s) 下载地址',
  'err.urlScheme': '仅支持 http/https 下载地址（收到 {scheme}://）；请使用以 https:// 开头的完整地址',
  'err.urlNoHost': '下载地址缺少主机名',
  'err.httpError': '下载失败：服务器返回 HTTP {status}',
  'err.http404': '下载地址不存在（HTTP 404）',
  'err.http403': '下载被拒绝（HTTP 403，服务器可能未公开该文件）',
  'err.network': '网络错误：{detail}',
  'err.timeout': '下载超时：连接服务器或接收数据超时，请检查网络后重试',
  'err.tooLarge': '文件过大（{size}，上限 {max}）',
  'err.tooLargeStream': '文件过大（超过 {max}）',
  'err.downloadEmpty': '下载响应没有内容',
  'err.downloadAborted': '下载已取消',
  'err.zipBadMagic': '下载的文件不是有效的 zip 压缩包（文件头不正确）',
  'err.zipCorrupt': '压缩包已损坏或不是有效的 zip（解压失败）；可能是下载不完整或文件格式不符',
  'err.zipEmpty': '压缩包是空的',
  'err.zipBomb': '压缩包条目过多（{count}，上限 {max}）',
  'err.zipBombSize': '解压后内容过大（超过 {max}）',
  'err.pathEmpty': '压缩包包含空路径条目',
  'err.pathUnsafe': '压缩包包含不安全的路径：{name}',
  'err.pathTraversal': '压缩包包含越界路径（zip-slip）：{name}',
  'err.payloadNoManifest': '压缩包内没有 manifest.json；这不是 SDE 镜像包（镜像 zip 应包含 manifest.json 与各表 .jsonl）',
  'err.payloadJsonInvalid': '压缩包内的 manifest.json 无法解析（不是有效的 JSON）',
  'err.payloadStructInvalid': '压缩包内的 manifest.json 结构无效',
  'err.payloadNoBuild': 'manifest.json 缺少有效的 buildNumber',
  'err.payloadNoTables': 'manifest.json 缺少 tables 表清单',
  'err.payloadEmptyTables': 'manifest.json 的 tables 是空的（没有数据表）',
  'err.payloadMissingTables': '压缩包缺少数据表文件：{tables}',
  'err.payloadMissingTablesMany': '压缩包缺少数据表文件：{tables} 等 {count} 个',
  'err.diskFull': '磁盘空间不足，无法写入数据',
  'err.diskDenied': '没有写入权限，无法保存数据',
  'err.diskError': '写入数据失败：{detail}',
}

export const enAccount: Record<EveAccountLocaleKey, string> = {
  accountTitle: 'EVE Account & Market',
  accountDescription: 'EVE SSO login and the default market region for market tools',
  charactersLabel: 'Authorized characters',
  noCharacters: 'No authorized characters',
  scopesCount: 'scopes {n}',
  expired: ' (expired)',
  deauth: 'Revoke',
  deauthAll: 'Revoke all',
  login: 'Log in with EVE',
  loginBusy: 'Logging in…',
  openLoginUrl: 'Open login page',
  defaultRegionLabel: 'Default market region',
  defaultRegionHint: 'Market tools default to Jita (The Forge) when unset; takes effect immediately.',
  noRegion: 'Unset (default Jita)',
  comingSoon: 'Coming soon',
  expand: 'Expand',
  collapse: 'Collapse',
  'status.idle.noCharacters': 'No authorized characters',
  'status.idle.authorized': 'Authorized characters are ready to use',
  'status.starting': 'Starting EVE login…',
  'status.waiting': 'Open the link in your browser to complete the EVE login',
  'status.authorized': 'Authorized: {name}',
}

export const en: Record<SdeCardLocaleKey, string> = {
  title: 'SDE Update',
  description: 'Update EVE static data (SDE) from a download URL; any http(s) address works, the zip must contain manifest.json and one .jsonl per table',
  urlLabel: 'Download URL',
  urlPlaceholder: 'https://example.com/sde/sde-20260731-mirror.zip',
  urlHint: 'http/https only; make sure the server is reachable. Network drops, bad URLs, and corrupt archives all produce explicit errors here.',
  update: 'Download & update',
  rollback: 'Rollback',
  rollbackHint: 'Switch back to the previous version kept on disk (recovers from a bad update).',
  unavailable: 'dsh-esi plugin not loaded: this card needs the plugin mounted on the host.',
  busy: 'Task in progress…',
  invalidUrl: 'Enter a full URL starting with http:// or https://',
  idle: 'Idle',
  checking: 'Checking',
  downloading: 'Downloading',
  extracting: 'Extracting',
  building: 'Building index',
  installing: 'Switching version',
  done: 'Done',
  error: 'Failed',
  noStatus: 'Waiting for status…',
  noData: 'No SDE data installed yet',
  officialDataLink: 'Official static data downloads (developers.eveonline.com/static-data)',
  expand: 'Expand',
  collapse: 'Collapse',
  'status.idle.noData': 'No SDE data installed yet',
  'status.idle.version': 'Current build: {build}',
  'status.checking': 'Checking download URL…',
  'status.probeReady': 'URL reachable, starting download',
  'status.probeReadySize': 'URL reachable, starting download ({size})',
  'status.probePassed': 'Mirror build {build} verified',
  'status.probePassedSize': 'Mirror build {build} verified ({size})',
  'status.downloading': 'Downloading {size}',
  'status.downloadingPercent': 'Downloading {size} ({percent}%)',
  'status.extracting': 'Extracting and validating…',
  'status.building': 'Building index (about a minute)…',
  'status.installing': 'Switching version…',
  'status.rollingBack': 'Rolling back to build {build}…',
  'status.updated': 'Update complete: switched to build {build}',
  'status.rolledBack': 'Rolled back',
  'status.rolledBackTo': 'Rolled back to build {build}',
  'err.busy': 'An update task is already running; please wait',
  'err.noRollback': 'No previous version to roll back to',
  'err.internal': 'Update failed: {detail}',
  'err.urlEmpty': 'Enter a download URL',
  'err.urlTooLong': 'Download URL too long (over {max} characters)',
  'err.urlControlChar': 'Download URL contains illegal control characters',
  'err.urlMalformed': '“{url}” is not a valid URL; enter a full http(s) download URL',
  'err.urlScheme': 'Only http/https download URLs are supported (got {scheme}://); use a full URL starting with https://',
  'err.urlNoHost': 'Download URL is missing a hostname',
  'err.httpError': 'Download failed: the server returned HTTP {status}',
  'err.http404': 'Download URL does not exist (HTTP 404)',
  'err.http403': 'Download denied (HTTP 403, the server may not have published the file)',
  'err.network': 'Network error: {detail}',
  'err.timeout': 'Download timed out connecting to or reading from the server; check your network and retry',
  'err.tooLarge': 'File too large ({size}, limit {max})',
  'err.tooLargeStream': 'File too large (over {max})',
  'err.downloadEmpty': 'Download response has no content',
  'err.downloadAborted': 'Download cancelled',
  'err.zipBadMagic': 'Downloaded file is not a valid zip archive (bad file header)',
  'err.zipCorrupt': 'Archive is corrupt or not a valid zip (extraction failed); the download may be incomplete or the format wrong',
  'err.zipEmpty': 'Archive is empty',
  'err.zipBomb': 'Archive has too many entries ({count}, limit {max})',
  'err.zipBombSize': 'Extracted content too large (over {max})',
  'err.pathEmpty': 'Archive contains an empty path entry',
  'err.pathUnsafe': 'Archive contains an unsafe path: {name}',
  'err.pathTraversal': 'Archive contains an out-of-bounds path (zip-slip): {name}',
  'err.payloadNoManifest': 'Archive has no manifest.json; this is not an SDE mirror package (a mirror zip must contain manifest.json and one .jsonl per table)',
  'err.payloadJsonInvalid': 'manifest.json inside the archive could not be parsed (not valid JSON)',
  'err.payloadStructInvalid': 'manifest.json inside the archive has an invalid structure',
  'err.payloadNoBuild': 'manifest.json is missing a valid buildNumber',
  'err.payloadNoTables': 'manifest.json is missing the tables list',
  'err.payloadEmptyTables': 'manifest.json has an empty tables list (no data tables)',
  'err.payloadMissingTables': 'Archive is missing table files: {tables}',
  'err.payloadMissingTablesMany': 'Archive is missing table files: {tables} and {count} more',
  'err.diskFull': 'Not enough disk space to write the data',
  'err.diskDenied': 'No write permission to save the data',
  'err.diskError': 'Failed to write data: {detail}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** SDE-update settings card copy (browser half of dsh-esi). */
    'dsh-esi.sde-card': SdeCardLocaleKey
    /** EVE account & market settings card copy. */
    'dsh-esi.eve-account': EveAccountLocaleKey
  }
}
