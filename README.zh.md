# dsh-esi

**DSH 0.2.2**（DeepSeek Harness）插件：接入 **EVE Online ESI API**（204 个端点）与 **SDE 静态数据**（100+ 张表）。

核心设计：**端点目录不进入系统提示词**。常驻工具面仅 ~13 个，模型按需用 `esi_endpoint_search` 查目录、用 `esi_call` 调任意端点、用 `esi_endpoint_load` 把热点端点物化为原生工具（agent 作用域，自动清理）。详见 [`docs/design.md`](docs/design.md)。

在 **插件** 面板点击 `@dsh-esi/plugin-esi` 卡片进入插件页，即可看到两张卡片：SDE 更新/回滚（实时进度）与 EVE 账号 + 默认市场星域；同一组卡片也出现在 **设置 → 插件** 的 `EVE ESI` 标签页。

## 环境要求

- DSH `^0.2.2-rc.5`（已声明 `engines.dsh`，由它单独判定兼容性）
- Node.js `>= 24.9`（SDE 查询依赖 `node:sqlite`）

## 工具面

| 工具 | 作用 |
|---|---|
| `esi_status` | 活跃服务器、目录统计、已授权角色 |
| `esi_endpoint_search` | **目录唯一入口**：关键词/tag 搜索 204 端点 |
| `esi_call` | 通用调度器：任意端点可调（认证/限流/重试/分页/缓存/错误归一化内置） |
| `esi_endpoint_load` | 热点端点按需物化为 `esi_<operationId>` 原生工具（上限 30/agent，可 unload） |
| `esi_item_lookup` | **热路径**：type_ids ↔ 物品名（中英文名搜索、本地化、未命中回报） |
| `esi_market_prices` | **热路径**：批量 type_ids 一次返回全服均价 + 吉他最优买卖价（挂单簿聚合、TTL 缓存、可选附物品名） |
| `esi_authorize` | EVE SSO 授权（loopback 回调，返回登录 URL 等待完成） |
| `esi_accounts` / `esi_deauthorize` | 查看/撤销已授权角色 |
| `sde_status` / `sde_query` | SDE 版本信息 / 表查询（过滤、搜索、投影、8 语言本地化） |
| `sde_update` / `sde_rollback` | **用户触发**的 SDE 更新（默认 dry-run，确认后执行；支持 `url` 参数从任意 http(s) 下载地址更新）+ 回滚 |

## 配置

`apply(ctx, config)`，字段（均可选）：

```ts
{
  server: 'cn' | 'global',          // 默认 'cn'（国服 Serenity）；'global' 为世界服 Tranquility
  ratePerSecond, maxPages, maxRetries,   // ESI 客户端（默认 15 rps / 50 页 / 3 次重试）
  maxMaterialized,                  // 物化工具上限（默认 30）
  clientIds: { cn?: string, global?: string },  // EVE 开发者应用 client id（esi_authorize / 登录卡片必需）
  callbackHost, callbackPort,       // SSO 回调（默认 127.0.0.1:32418，需在开发者后台注册该回调）
  defaultCharacterId,               // 多个已存 token 都满足 scope 时的优先角色
  authStorePath,                    // token 存储（默认 $DSH_HOME/.dsh-esi/auth.json）
  dataRoot,                         // SDE 数据根（默认 <package>/data）
  sdeLanguage,                      // SDE 本地化默认语言（默认 en）
  sdeUpdateSource,                  // 更新源（默认无；用 JsonlSdeSource 指向 jsonl 镜像）
  sdeUpdateUrl,                     // 更新卡片预填的默认镜像地址
  defaultMarketRegionId,            // esi_market_prices 的初始默认市场星域
}
```

## 设置卡片

浏览器半面把两张卡片同时注册到插件面板中该 bundle 自己的页面（`plugins.bundle.config`，按包名键控——DSH 依据它判断该 bundle 有配置页）以及“设置 → 插件”的 `EVE ESI` 标签页：

- **SDE 更新**：下载地址输入、更新/回滚按钮、实时阶段/进度/错误。
- **EVE 账号**：EVE SSO 登录（卡片给出登录链接，用户打开完成）、已授权角色与逐个撤销、默认市场星域选择。

在 DSH 0.2.2 中的实现方式：

- DSH 0.2 的配置表单来自各插件条目的 `Config`，旧的临时 settings 命名空间已移除；临时状态也不应写进用户 profile。
- 因此 host 通过 Web server 路由表暴露一个同源 JSON 桥（`/dsh-esi/api/*`，见 `src/ui/bridge.ts`）。卡片可见期间每秒轮询一份状态，并在每次用户操作时 POST 一个动作；动作响应本身已带最新状态。
- 这些操作与工具共用同一实现：卡片的更新/回滚调用 `sde_update` 也在用的 `SdeUpdateRunner`，聊天与卡片不会并发操作同一数据根；账号登录复用 `EsiaAuthService`。
- 桥是可选的：没有 Web server 的 headless / Desktop 组合不会挂载它，工具照常可用。写操作拒绝跨源请求并要求 JSON 请求体；该接口仅限本机使用。
- 浏览器半面只从模块表取 React，注册进 `settings.plugins.tab`；其余包引用均为类型导入。

## SDE 数据

- 版本目录自包含：`data/<version>/`（jsonl + `_sde.jsonl` + `manifest.json` + `sde.db`），`data/current` 软链指向当前版本；jsonl 是规范源，`sde.db` 是派生的 SQLite 读库（`node:sqlite`，可重建）。
- 首次使用/数据变更后运行 `node scripts/build-manifest.mjs` 生成 manifest + `sde.db`（553MB 全量约 11s，101 张表全部可索引查询）。
- 更新（两种方式）：
  1. 配置源：`sdeUpdateSource: new JsonlSdeSource({ baseUrl })` 后，模型调用 `sde_update`（先 `confirm=false` 出计划，用户同意后 `confirm=true` 执行）。
  2. 任意下载地址：`sde_update` 传 `url` 参数，或在设置卡片里粘贴。支持两种布局：**官方 CCP 静态数据 jsonl 包**（`_sde.jsonl` + 各表 `.jsonl`，如 `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-<build>-jsonl.zip`）和**带 `manifest.json` 的 jsonl 镜像 zip**。无需预配置源；dry-run 先 HEAD 探测可达性与大小，确认后下载 → 校验（zip 完整性 / zip-slip 防护 / 载荷校验）→ 构建索引 → 原子切换，旧版本保留可回滚。
- 错误处理：URL 校验（仅 http/https）、连接失败/超时/HTTP 状态/下载中断按类型报错并自动重试瞬时故障、文件大小上限、磁盘空间不足提示；所有错误返回稳定 `code` + 中文 `message`（见 `src/sde/zip-source.ts` 的 `SdeZipError`）；状态以 `messageKey` + `messageParams` 下发，由卡片按当前界面语言翻译。
- 官方 SDE zip（CSV/YAML）转换器为待办：按 `SdeUpdateSource` 接口实现 `OfficialZipSdeSource`。

## 开发

```bash
npm install                       # 全部依赖来自 npm 上的 DSH 0.2.2，无需 harness checkout
npm run gen                       # 从 public/json/esi.json 重新生成端点目录
node scripts/build-manifest.mjs   # 构建 SDE manifest + 索引
npm test                          # 测试（99 用例，mock 服务器 + 真实 Web server，无需网络）
npm run typecheck                 # 同时检查 host 与浏览器半面
npm run build                     # tsdown → lib/index.js + lib/client.js
node scripts/verify-client.mjs    # 浏览器包结构检查（loader id / 槽位 / 组件渲染）
node scripts/smoke.mjs            # 离线全链路冒烟（mock，需 data/ 就位）
node scripts/e2e-real.mjs         # 真实网络 e2e（国服公开端点，需外网）
node scripts/acceptance.mjs       # 真实 `dsh web` 挂载 + 桥接口检查（需要 PATH 中有 dsh）
```

## 构建与发布

```bash
npm run build       # tsdown 构建 lib/（host 单文件 ESM：peers 外挂、fflate 内联、node: 内置外置；浏览器半面为 CJS 闭包）
npm pack            # 本地打包检查 tarball 内容（files 白名单：lib/ + cordis.patch.yml + README + LICENSE + package.json）
```

- 根 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`：包是标准**组合包（bundle）**，`dsh plugin add` 会把插件行按包名插入 profile 层；浏览器半面由同一 manifest 的 `dsh.client` 声明自动发现（无需单独的行）。
- `engines.dsh` 为 `^0.2.2-rc.5`。DSH 只读该范围判定兼容性，因此要支持更多 DSH 版本时需显式放宽。
- `prepare` 钩子 = `tsdown`：git/path 方式安装时自动构建，`lib/` 不进 git（见 .gitignore）。
- 引擎要求 `node >= 24.9`。
- **发布形态**：社区插件市场校验根 `package.json` 的 `dsh.bundle.patch`（本包已声明）。内部使用可 `git tag -a v0.2.1` 后 `dsh plugin add`（git 地址/本地路径/tarball 均可）；上 npm 需 `@dsh-esi` org 拥有者执行 `npm publish --access public`，tarball 内已含 `cordis.patch.yml`。
- **数据不进包**：`data/` 被 .gitignore 且不在 files 白名单；消费者装完需自行获取 SDE 数据（见上文「SDE 数据」）。

## 在 DSH GUI 中调试

`scripts/web-patch.yml` 通过绝对路径挂载构建产物，真实 loader 直接运行，无需改动 harness 工作区：

```bash
npm run build
DSH_HOME=$PWD/.tmp/run-home dsh web --patch "$PWD/scripts/web-patch.yml" --no-open --port 3081
node scripts/acceptance.mjs      # 在随机端口启动同一组合并检查桥接口
```

路径行不携带包 manifest，因此 client-module 扫描不会发现浏览器半面。要验证 `EVE ESI` 标签页，把包安装进一次性 profile：

```bash
DSH_HOME=/tmp/dsh-esi-home dsh plugin --profile web add /home/alex/project/dsh-esi
DSH_HOME=/tmp/dsh-esi-home dsh web --no-open
```

卡片出现在插件面板的 bundle 页面；同一组卡片也在“设置 → 插件”标签页。`sde_update` / `sde_rollback` / `esi_authorize` 仍是 agent 侧入口，与卡片共用同一操作。

## 迁移到 DSH 0.2.2

- **工具执行**：DSH 0.2 把执行模式拆成显式执行器插件，`ToolsService.execute` 改为接收一批模型调用。测试与脚本挂载 `@deepseek-ai/dsh-tool-executor-native` 并使用批量协议。
- **值类型**：`JsonValue` 移至 `@deepseek-ai/dsh-util-values`，`dsh-tools` 不再导出。
- **设置**：临时 `settingsNamespace` / `settingsScope` 通道已移除。可编辑配置走插件 `Config`；卡片实时状态改走上述 host JSON 桥。
- **浏览器半面**：`@deepseek-ai/dsh-client-runtime` 已不存在，`ClientContext` 即 Cordis `Context`；旧 `settings.plugin.item` 槽改为 `settings.plugins.tab`（整页用 `settings.section`），标签页以本地化 label thunk 注册。
- **兼容性**：`engines.dsh` 单独判定、要求 Node 24.9+；Web profile 用 `webStartup` 取代 `webRuntime`（监听覆盖层无需再写 webserver 行）。

## 状态

| 阶段 | 状态 |
|---|---|
| 目录代码生成（204 端点） | ✅ |
| ESI 客户端层（认证/限流/分页/缓存/错误） | ✅ |
| 工具面（search/call/按需物化） | ✅ |
| EVE SSO OAuth + 写操作审批门 | ✅ |
| SDE 查询 + 用户触发更新/回滚 | ✅ |
| 设置卡片（SDE + 账号，0.2.2 桥） | ✅ |
| 真实网络 e2e | ✅ |
| 官方 SDE zip 转换器 | 待办 |

---

English: [README.md](README.md)
