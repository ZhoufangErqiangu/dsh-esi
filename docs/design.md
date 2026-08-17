# dsh-esi 插件设计文档

> 目标：在 DSH（DeepSeek Harness）中实现一个接入 EVE Online **ESI API** 与 **SDE 静态数据** 的 Cordis 插件。
> 本文件先解决核心难点 —— **204 个 ESI 端点不能全部暴露为工具**，再给出整体架构、SDE 更新方案与实施顺序。

---

## 0. 现状盘点（事实基线）

### 0.1 ESI swagger（`public/json/esi.json`）

| 指标 | 数值 | 含义 |
|---|---|---|
| Swagger 版本 | 2.0（OpenAPI for EVE Online v1.19） | 老式 spec，含全局 `$ref` 参数 |
| paths / operations | 189 / **204** | 其中 GET 170、POST 20、PUT 7、DELETE 7 |
| tags | 32 | Universe(30)、Corporation(22)、Character(14)、Fleets(14)、Market(11)… |
| 需要 OAuth（evesso）的操作 | **124 / 204** | 大多数读角色/公司数据需要 scope |
| 带路径模板参数的操作 | 144 / 189 | 如 `/characters/{character_id}/assets/` |
| 参数形态 | path 72、query 32、body 21 | 全局参数：datasource / If-None-Match / page / token / language… |
| host / basePath | `ali-esi.evepc.163.com` / `/latest` | **网易国服镜像**（晨曦），非世界服 esi.evetech.net |
| authorizationUrl | `https://login.evepc.163.com/v2/oauth/authorize` | flow: implicit |

要点：
- 124 个端点需要 EVE SSO OAuth token 且带 scope；scope 表（`securityDefinitions.evesso.scopes`）约上百个，如 `esi-assets.read_assets.v1`。
- 分页约定：`page` 查询参数 + 响应头 `X-Pages`；缓存约定：`If-None-Match` / ETag / `expires` 头。
- 限流约定：软上限 20 req/s，错误码 420 / 520 表示限流，须退避重试。
- 网易国服与世界服是**两套完全不同的 login 域名与 ESI host**，插件需可切换。

### 0.2 SDE 静态数据（`data/eve-online-static-data-3470007-jsonl/`）

- 102 张表、约 553MB 的 jsonl（每行一个 JSON 对象，`_key` 为主键）。
- 最大表：mapMoons(214M)、types(146M)、missions(51M)、mapPlanets(49M)、typeDogma(27M)。
- 本地化字段是嵌套对象：`name: {de,en,es,fr,ja,ko,ru,zh}`，查询需支持语言选择。
- 目录名中的 `3470007` 是构建号；该格式来自第三方 jsonl 导出（非官方 zip 原样），更新方案需考虑来源。

### 0.3 DSH 插件机制（已核对 harness 源码）

- 插件契约：导出 `name` / `inject` / `apply(ctx)`（参考 `packages/extensions/tool-cordis`）。
- `ctx.tools.register(defineTool(...))` —— 返回 disposer，**支持运行时注册/注销**；按作用域注册走 `agent.ctx`（scoped context），scoped 工具 shadow 全局工具。
- `ctx.tools.restrict({allow|deny})` —— 按 agent 作用域裁剪全局工具。
- `ctx.systemPrompt.section({name, order, text})` —— 注入 prompt 段落，`text` 可为按 assembly 求值的 provider。
- `ctx.on('agent/pre-step', ...)` —— 每一步前挂钩，可注入上下文消息（tool-cordis 的 `@pluginId` 注入即此模式）。
- `tools/pre-execute | execute | post-execute` —— 每个工具调用的策略瀑布：approval（`ask`）、重试、超时等。
- `mode: 'code'` —— 把模型可见工具面收敛为单个 `run_code` + SDK prompt（全局呈现模式，SDK 仍含全部 schema，不适合本场景的"零污染"诉求，但插件需与之兼容）。

---

## 1. 核心问题与设计原则

### 1.1 问题

204 个端点若全部注册为原生工具：
- 每个工具 schema 约 100~200 token，合计 **20K~40K token** 常驻系统提示词；
- 模型在选择工具时的准确率随候选数量上升而显著下降（工具选择退化）；
- 大量 token 挤占推理预算，直接损害用户关心的"推理质量"。

### 1.2 设计原则

1. **常驻工具面最小化** —— 模型每步看到的工具始终只有个位数。
2. **目录不进 prompt，按需查询** —— 204 个端点的目录做成可搜索索引，模型需要时才查，查到的只是子集。
3. **热点端点按需物化** —— 反复使用的端点可被"物化"为带完整 schema 的原生工具（利用 DSH 运行时注册 + agent 作用域），兼顾准确性与上下文成本。
4. **一次生成、零手工搬运** —— 从 swagger.json 代码生成目录模块，避免逐端点手写（正是用户要避免的"机械搬运"）。
5. **平台机制优先** —— 复用 DSH 的 registry / scoped context / approval / credentials，不另造轮子。
6. **数据永不进上下文** —— SDE 553MB 只在磁盘 + 惰性内存缓存，模型只看到查询结果子集。

---

## 2. 整体架构

```
┌────────────────────────────── build time ─────────────────────────────┐
│  scripts/gen-catalog.mjs                                              │
│    public/json/esi.json ──► src/generated/catalog.ts（紧凑目录）       │
│    （解析 $ref、压缩 summary、提取 scope/分页/必填参数）                 │
└───────────────────────────────────────────────────────────────────────┘
┌────────────────────────────── runtime ────────────────────────────────┐
│  plugin (name/inject/apply)                                           │
│  ├─ CatalogService   目录搜索（内存索引，204 行）                      │
│  ├─ EsiaClient       HTTP 层：双服务器、OAuth 附加、限流、分页、缓存、  │
│  │                   错误归一化                                        │
│  ├─ AuthService      OAuth 授权 + token 存储（credentials 服务）       │
│  └─ SdeService       数据目录、惰性查询、热索引、增量更新、回滚        │
│                                                                       │
│  工具表面（见 §3）：固定小面 ~9 个 + 按需物化的原生工具（agent 作用域） │
│  系统提示词段：ESI/SDE 使用指引（~300 token，不含端点目录）            │
│  （可选）客户端半部：OAuth 回调页 + 认证/数据管理面板                  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 3. 工具表面设计（核心答案）

### 3.1 固定常驻工具（~9 个，全部端点可达但零目录开销）

| 工具 | 作用 |
|---|---|
| `esi_endpoint_search` | 按关键词/tag 搜索 204 个端点，返回紧凑匹配（operationId、method、path、summary、所需 scope、必填参数）。**这是目录的唯一入口** |
| `esi_call` | 通用调度器：`operation_id` + `path_params`/`query`/`body`，内部校验目录、附加认证、限流、分页、缓存，返回 `{data, meta}`。**任何端点都可通过它调用** |
| `esi_endpoint_load` | 将 1 个端点（或整个 tag）**物化**为原生工具注册到当前 agent 作用域（`agent.ctx.tools.register`），下一步起模型可原生调用；会话结束自动注销 |
| `esi_authorize` | EVE SSO OAuth 授权：请求指定 scope，返回已授权角色列表 |
| `esi_accounts` | 查看/注销已授权角色与 scope（授权管理） |
| `esi_status` | 服务器健康、当前授权角色、限流状态、缓存统计 |
| `sde_status` | 数据版本/构建号、表清单与行数、来源、索引状态 |
| `sde_query` | 查询单张表：结构化过滤 + 字段搜索 + 字段投影 + limit + 语言 |
| `sde_update` | **用户触发**的 SDE 更新（默认 dry-run 预览，二次确认后增量下载、校验、原子切换、可回滚） |

prompt 指引段（systemPrompt.section，约 300 token）：

> ESI 提供 204 个端点，未在此全部列出。先调用 `esi_endpoint_search` 按关键词找到目标端点，再用 `esi_call` 调用；若某端点会被反复使用，用 `esi_endpoint_load` 将其物化为原生工具以获得参数校验。涉及写入的操作（POST/PUT/DELETE）需要用户批准。

### 3.2 按需物化（`esi_endpoint_load`）规则

- **作用域**：注册到 `exec.agent.ctx`（scoped），仅当前 agent 可见，会话/agent 结束由 ctx effect disposer 自动注销。
- **命名**：`esi_<operationId>`（如 `esi_get_characters_character_id_assets`），避免与固定工具冲突。
- **schema**：由目录生成——路径参数、查询参数（含枚举）、body 均转为 JSON Schema。
- **上限**：每 agent 物化数量上限（默认 30），超限时按 LRU 提示模型释放（`esi_endpoint_unload`）或自动回收最久未用者；防止物化面失控。
- **失效**：`tools/change` 事件驱动；agent 销毁自动清理。

### 3.3 为什么不是其他方案

| 方案 | 结论 |
|---|---|
| 全量 204 个原生工具 | 20K~40K token 常驻 + 选择退化 → **否决**（用户已预判） |
| 仅 dispatcher（`esi_call` + 目录搜索） | 可行且最简单，但热点端点失去原生参数校验与逐工具指引 → 作为**保底路径**保留，与物化方案共存 |
| 全局 `mode: 'code'` 折叠 | SDK 仍含全部 schema、且是全局呈现模式，不是 ESI 专属解法 → 不采用（插件与 code mode 兼容即可） |
| MCP 服务 | 工具列表仍需全量暴露或自行实现懒加载，且失去 DSH 原生作用域/审批机制 → 不采用 |

---

## 4. ESI 客户端层（`esi_call` 内部职责，模型不感知）

- **双服务器**（配置 `server: 'cn' | 'global'`）：
  - CN：`https://ali-esi.evepc.163.com` / `https://login.evepc.163.com`
  - Global：`https://esi.evetech.net` / `https://login.eveonline.com`
  - 默认取打包 swagger 对应的 CN；swagger 可随配置重新拉取。
- **认证**：按端点所需 scope 自动附加 token；token 存储走 DSH credentials 服务（本地加密文件）；scope 不足时返回明确错误 `requiredScope: "esi-..."` 并提示 `esi_authorize`。
- **限流**：令牌桶 ~15 req/s；420/520 按 `Retry-After` 指数退避；熔断保护。
- **分页**：默认单页 + `meta.pages`（X-Pages）；`options.pages: 'auto'` 时自动拉全量（带页数上限，如 50），避免模型手工翻页。
- **缓存**：ETag / If-None-Match + `expires` 头的内存 TTL 缓存。
- **错误归一化**：统一 `{ok, status, code, message, retryable, requiredScope?}`；404/403/420/520 语义化。
- **写入审批**：POST/PUT/DELETE（34 个操作）经 `tools/pre-execute` 策略置 `ask`，复用 DSH approval 服务。

---

## 5. SDE 设计

### 5.1 数据形态与查询

- 磁盘：jsonl 表 + `data/manifest.json`（构建号、来源 URL、每表行数/sha256/索引状态）。
- 查询：惰性读入内存缓存（LRU，按表容量上限淘汰，如合计 ≤1GB）；结构化过滤
  `filter: {field: value | {gte,lte,in,ne}}` + 指定字段文本搜索 + 字段投影 + `limit`（默认 20，上限 200）+ `language`（默认 en/zh 可配）。
- **SQLite 读库**（2026-08 落地，替代初版字节偏移热索引）：构建阶段把 jsonl 导入派生的 `sde.db`（`node:sqlite`，101 表全量约 11s）；每表建 `id` 主键、`name_<lang>` 本地化列、数值字段类型化列 + 索引，`row` 列保留原始行（投影/本地化解析）；查询翻译成 SQL，未提升字段走 `json_extract`；实测 type 587 查询 <0.1ms、名字 LIKE ~1ms。

### 5.2 用户自主更新方案（`sde_update`）—— 已定：官方 SDE zip + 内置转换

**来源（用户已确认）**：官方 SDE zip（CCP 静态数据导出，`resources/staticdata`，CSV + YAML）→ 插件内置转换器生成 jsonl。转换规范以当前 `data/` 目录的 jsonl 约定为准（`_key` 主键、`name`/`description` 本地化嵌套对象、表名小驼峰），保证新旧数据形态一致。

流程（**由用户显式触发**，不自主执行；大下载需审批）：

1. `sde_update --dry-run`（默认）：探测官方 SDE 最新构建号（如 `sde-20240731-TRANQUILITY.zip`），与本地 manifest 的构建号对比，报告更新内容与预估下载/转换耗时。
2. 确认后：
   a. 下载 zip（可断点续传）→ 校验 zip 完整性；
   b. 解压；**并行转换**：CSV（含 `*` 列名头）与语言文件（`_en-us.csv` 等）合并出本地化对象、YAML（fsd）转 JSON → 写新目录 `data/sde-<build>/`，进度上报；
   c. 逐表 sha256 与上一版本比对，**未变化的表跳过写入**（首次转换后增量更新只重写变化表）；
   d. 更新 `data/manifest.json` → **原子切换** `data/current` 软链 → 构建热索引；
   e. **保留上一版本**用于回滚（`sde_rollback` 或 `sde_update --rollback`）。
3. 数据目录结构：`data/sde-<build>/...` + `data/current -> sde-<build>` + `data/manifest.json`（含每表行数/sha256/构建号/来源 URL）。

实现状态：`sde_update` 机制（dry-run 计划 / sha256 增量 / 原子切换 / 回滚）已按 §5.2 落地并测试通过；交付两个源适配器：
- **JsonlSdeSource**（配置源）：消费与本插件数据同构的 jsonl+manifest 镜像；
- **ZipSdeSource**（`sde_update` 的 `url` 参数，用户任意输入）：任意 http(s) URL → zip（jsonl 镜像包）→ 下载 → 校验 → 原子安装。完整错误分类：URL 校验（仅 http/https，拒绝 file:// 等）、网络错误（连接失败/超时/HTTP 状态/下载中断，瞬时故障自动重试退避）、zip 完整性（魔数 + fflate 解压）、zip-slip 路径防护、zip 炸弹（条目数与解压大小上限）、载荷校验（manifest.json/buildNumber/表文件齐全）、磁盘空间/权限；失败永远清理 staging，旧版本保持可查询直到原子切换完成（`GuiRunner` 先在 staging 构建索引再 rename 切换）。错误统一为 `SdeZipError`（稳定 `code` + 中文 `message`）。

**官方 SDE zip 转换器（CSV/YAML → jsonl）为待办**：按 `SdeUpdateSource` 接口实现 `OfficialZipSdeSource`（下载 → 解压 → 并行转换 → 校验 → 交付版本目录），转换规范以现有 jsonl 约定为准。

设置页卡片（下载地址输入框 + 更新按钮）的 host 端管线（`SdeGuiRunner` 状态机 + `dsh-esi` settings 命名空间桥）已实现并测试，但浏览器端卡片需将 dsh-esi 作为 `dsh.client` 包接入 web bundle（harness node_modules 符号链接或改 web 组合），当前未启用；更新入口为 `sde_update` 聊天工具。
- 官方 zip 实测 URL（2026-08）：`https://eve-static-data-export.s3-eu-west-1.amazonaws.com/tranquility/sde.zip`（HEAD 200，约 112MB）；国服同桶 `serenity/sde.zip` 返回 403（未发布），国服数据更新需以世界服 zip 为准或另寻源。
- 转换器依赖：CSV 解析（`*` 列名头 + `<table>_<lang>.csv` 语言文件合并）可纯 Node 实现；fsd YAML 需引入最小 YAML 解析依赖（如 `yaml`），按 `SdeUpdateSource` 接口交付。

数据目录结构（当前）：`data/<version-dir>/`（含 `_sde.jsonl`、`manifest.json`、`sde.db`）+ `data/current -> <version-dir>` 软链；`scripts/build-manifest.mjs` 负责生成 manifest 与派生的 SQLite 读库（jsonl 为规范源，查询走 `node:sqlite` 的索引/JSON1，全量构建约 11s）。

---

## 6. 仓库结构与实施顺序

```
dsh-esi/
├─ public/json/esi.json          # swagger（已下载，可再拉取）
├─ data/…                        # SDE 数据（当前版本 + 后续版本目录）
├─ docs/design.md                # 本文档
├─ scripts/gen-catalog.mjs       # swagger → 目录模块生成器
├─ src/
│  ├─ generated/catalog.ts       # 生成的紧凑目录（204 端点元数据）
│  ├─ catalog.ts                 # 目录搜索服务
│  ├─ esia-client.ts             # HTTP/限流/分页/缓存/错误归一化
│  ├─ auth.ts                    # OAuth + token 存储
│  ├─ sde/{manifest,query,update,index}.ts
│  ├─ tools/                     # 固定工具 + 物化器
│  ├─ prompt.ts                  # 系统提示词段
│  └─ index.ts                   # plugin: name/inject/apply
├─ client/                       # （可选）客户端半部：OAuth 回调/设置面板
└─ tests/                        # 单测（mock ESI）+ 可选 e2e（公开端点）
```

实施阶段：

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 仓库脚手架（package、tsconfig、vitest、插件骨架） | 插件可被 DSH 加载 |
| 1 | `gen-catalog.mjs` 生成目录；单测覆盖全部 204 个操作、`$ref` 全解析 | 目录数据完备 |
| 2 | EsiaClient：双服务器、限流、分页、缓存、错误归一化（mock server 单测） | 公开端点可调通 |
| 3 | 工具面：`esi_endpoint_search` + `esi_call` + prompt 段；`esi_endpoint_load` 物化（agent 作用域） | 上下文常驻 < 1K token 可完成任意端点调用 |
| 4 | OAuth 授权（服务端 + 客户端回调页）+ credentials 存储 | 可授权角色并调用受保护端点 |
| 5 | SDE：manifest、`sde_query`、热索引；官方 zip 转换器 `scripts/convert-sde`（并行、断点续传、进度） | 常用查询 < 数百 ms；转换器可把官方 zip 转成与当前 data/ 一致的 jsonl |
| 6 | `sde_update` 全流程：dry-run → 下载 → 转换 → 校验 → 原子切换 → 回滚 + 审批 | 可完成一次真实更新与回滚 |
| 7 | 文档、e2e（真实公开端点）、CN/Global 切换验证 | 交付 |

---

## 7. 决策记录（已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 服务器范围 | **国服 + 世界服可切换**（配置 `server: 'cn' \| 'global'`） |
| 2 | 工具面方案 | **混合式**：`esi_endpoint_search` + `esi_call` + `esi_endpoint_load` 按需物化 |
| 3 | SDE 更新来源 | **官方 SDE zip + 内置转换**（见 §5.2） |
| 4 | 认证流程 | 待定：swagger 声明 implicit flow；实现时优先探测 authorization-code（更安全），以 login 后台实际支持为准 |
