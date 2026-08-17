# dsh-esi

DSH（DeepSeek Harness）插件：接入 **EVE Online ESI API**（204 个端点）与 **SDE 静态数据**（100+ 张表）。

核心设计：**端点目录不进入系统提示词**。常驻工具面仅 ~10 个，模型按需用 `esi_endpoint_search` 查目录、用 `esi_call` 调任意端点、用 `esi_endpoint_load` 把热点端点物化为原生工具（agent 作用域，自动清理）。详见 [`docs/design.md`](docs/design.md)。

## 工具面

| 工具 | 作用 |
|---|---|
| `esi_status` | 活跃服务器、目录统计、已授权角色 |
| `esi_endpoint_search` | **目录唯一入口**：关键词/tag 搜索 204 端点 |
| `esi_call` | 通用调度器：任意端点可调（认证/限流/重试/分页/缓存/错误归一化内置） |
| `esi_endpoint_load` | 热点端点按需物化为 `esi_<operationId>` 原生工具（上限 30/agent，可 unload） |
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
  clientIds: { cn?: string, global?: string },  // EVE 开发者应用 client id（esi_authorize 必需）
  callbackHost, callbackPort,       // SSO 回调（默认 127.0.0.1:32418，需在开发者后台注册该回调）
  authStorePath,                    // token 存储（默认 $DSH_HOME/.dsh-esi/auth.json）
  dataRoot,                         // SDE 数据根（默认 <package>/data）
  sdeLanguage,                      // SDE 本地化默认语言（默认 en）
  sdeUpdateSource,                  // 更新源（默认无；用 JsonlSdeSource 指向 jsonl 镜像）
}
```

## SDE 数据

- 版本目录自包含：`data/<version>/`（jsonl + `_sde.jsonl` + `manifest.json` + `sde.db`），`data/current` 软链指向当前版本；jsonl 是规范源，`sde.db` 是派生的 SQLite 读库（`node:sqlite`，可重建）。
- 首次使用/数据变更后运行 `node scripts/build-manifest.mjs` 生成 manifest + `sde.db`（553MB 全量约 11s，101 张表全部可索引查询）。
- 更新（两种方式）：
  1. 配置源：`sdeUpdateSource: new JsonlSdeSource({ baseUrl })` 后，模型调用 `sde_update`（先 `confirm=false` 出计划，用户同意后 `confirm=true` 执行）。
  2. 任意下载地址：`sde_update` 传 `url` 参数（http/https，指向**jsonl 镜像 zip**：内含 `manifest.json` + 各表 `.jsonl`）。无需预配置源；dry-run 先 HEAD 探测可达性与大小，确认后下载 → 校验（zip 完整性 / zip-slip 防护 / 载荷校验）→ 构建索引 → 原子切换，旧版本保留可回滚。
- 错误处理：URL 校验（仅 http/https）、连接失败/超时/HTTP 状态/下载中断按类型报错并自动重试瞬时故障、文件大小上限、磁盘空间不足提示；所有错误返回稳定 `code` + 中文 `message`（见 `src/sde/zip-source.ts` 的 `SdeZipError`）。
- 官方 SDE zip（CSV/YAML）转换器为待办：按 `SdeUpdateSource` 接口实现 `OfficialZipSdeSource`。
- 设置页卡片（下载地址输入框 + 更新按钮）已实现 host 端全部管线，但浏览器端卡片需要把 dsh-esi 作为 `dsh.client` 包接入 web bundle（需在 harness 的 node_modules 挂符号链接或改 web 组合），目前**未启用**——更新请走 `sde_update` 聊天工具。

## 开发

```bash
node scripts/link-harness.mjs     # 首次/克隆后：链接 harness 预构建包（dsh-scope 等 4 个）
node scripts/gen-catalog.mjs      # 从 public/json/esi.json 重新生成端点目录
node scripts/build-manifest.mjs   # 构建 SDE manifest + 索引
node --test 'tests/*.test.mjs'    # 测试（56 用例，mock 服务器，无需网络）
node scripts/smoke.mjs            # 离线全链路冒烟（mock，需 data/ 就位）
node scripts/e2e-real.mjs         # 真实网络 e2e（国服公开端点，需外网）
```

类型检查（零安装，复用 harness 预构建类型）：`tsc -p tsconfig.json`（需要 harness checkout 位于兄弟目录）。

## 在 DSH GUI 中调试（已打通）

插件通过 **loader 按绝对路径挂载**，无需改动 harness 工作区（`EntryTree.import(name)` 直接动态 import 该路径；插件自身依赖从自己的 `node_modules` 解析，SDE 数据从 `src/../data` 解析）：

```bash
# 1) 独立实例验证（端口 3081，与 3080 生产 GUI 共存；同 loader/patch 路径）：
DSH_HOME=/tmp/dsh-esi-home node --import tsx/esm ../deepseek-harness/apps/cli/src/bin.ts web \
  --patch /home/alex/project/dsh-esi/scripts/web-patch.yml

# 2) 进程内探针：真实 profile 组合 + 同一 patch，跑通 esi_status/search/call/sde_query：
DSH_HOME=/tmp/dsh-esi-home node --import tsx/esm /home/alex/project/dsh-esi/scripts/gui-probe.mjs
```

**挂到正在运行的 :3080 GUI（热加载，无需重启）**：把 `scripts/web-patch.yml` 里的
`- insert:` 块（去掉 webserver 行）写进 `~/.dsh/profiles/web/cordis.patch.yml`，运行中的实例
自动重载并挂载插件；删掉该块即卸载。patch 内的 `name` 是绝对路径，换机器需改。

```yaml
- insert:
    - id: dsh-esi
      name: /home/alex/project/dsh-esi/src/index.ts
      config:
        server: cn
```


## 状态

| 阶段 | 状态 |
|---|---|
| 目录代码生成（204 端点） | ✅ |
| ESI 客户端层（认证/限流/分页/缓存/错误） | ✅ |
| 工具面（search/call/按需物化） | ✅ |
| EVE SSO OAuth + 写操作审批门 | ✅ |
| SDE 查询 + 用户触发更新/回滚 | ✅ |
| 真实网络 e2e | ✅ |
| 官方 SDE zip 转换器 | 待办 |
