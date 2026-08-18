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
  | 'expand'
  | 'collapse'

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
  expand: '展开',
  collapse: '收起',
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
  expand: 'Expand',
  collapse: 'Collapse',
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
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** SDE-update settings card copy (browser half of dsh-esi). */
    'dsh-esi.sde-card': SdeCardLocaleKey
    /** EVE account & market settings card copy. */
    'dsh-esi.eve-account': EveAccountLocaleKey
  }
}
