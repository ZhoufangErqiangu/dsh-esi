# dsh-esi

A **DSH 0.2.2** (DeepSeek Harness) plugin bridging the **EVE Online ESI API** (204 endpoints) and **SDE static data** (100+ tables).

Core design: **the endpoint catalog never enters the system prompt**. The always-resident tool surface stays at ~13 tools; the model queries the catalog on demand with `esi_endpoint_search`, calls any endpoint with `esi_call`, and materializes hot endpoints as native tools with `esi_endpoint_load` (agent-scoped, auto-cleaned). See [`docs/design.md`](docs/design.md) for details.

The plugin's page in the **Plugins** panel (click the `@dsh-esi/plugin-esi` card) adds two cards: SDE update/rollback with live progress, and EVE account + default market region. The same cards are also a tab in **Settings → Plugins**.

## Requirements

- DSH `^0.2.2-rc.5` (`engines.dsh` is declared and decides compatibility)
- Node.js `>= 24.9` (SDE queries use `node:sqlite`)

## Tool surface

| Tool | Purpose |
|---|---|
| `esi_status` | Active server, catalog statistics, authorized characters |
| `esi_endpoint_search` | **The only way into the catalog**: keyword/tag search over the 204 endpoints |
| `esi_call` | Generic dispatcher: call any endpoint (auth / rate limiting / retry / pagination / caching / error normalization built in) |
| `esi_endpoint_load` | Materialize hot endpoints on demand as native `esi_<operationId>` tools (cap 30/agent, unloadable) |
| `esi_item_lookup` | **Hot path**: type_ids ↔ item names (Chinese/English name search, localization, miss reporting) |
| `esi_market_prices` | **Hot path**: batch type_ids → server-wide average plus best Jita buy/sell prices in one call (order-book aggregation, TTL cache, optional item names) |
| `esi_authorize` | EVE SSO authorization (loopback callback; returns the login URL and waits for completion) |
| `esi_accounts` / `esi_deauthorize` | List / revoke authorized characters |
| `sde_status` / `sde_query` | SDE version info / table query (filter, search, projection, 8-language localization) |
| `sde_update` / `sde_rollback` | **User-triggered** SDE update (dry-run by default, executes after confirmation; `url` updates from any http(s) download address) + rollback |

## Configuration

`apply(ctx, config)`, all fields optional:

```ts
{
  server: 'cn' | 'global',          // default 'cn' (CN Serenity); 'global' is Tranquility
  ratePerSecond, maxPages, maxRetries,   // ESI client (defaults 15 rps / 50 pages / 3 retries)
  maxMaterialized,                  // materialized-tool cap (default 30)
  clientIds: { cn?: string, global?: string },  // EVE developer-app client id (required for esi_authorize / the login card)
  callbackHost, callbackPort,       // SSO callback (default 127.0.0.1:32418; register it as a callback URL)
  defaultCharacterId,               // preferred character when several stored tokens qualify
  authStorePath,                    // token storage (default $DSH_HOME/.dsh-esi/auth.json)
  dataRoot,                         // SDE data root (default <package>/data)
  sdeLanguage,                      // default SDE localization language (default en)
  sdeUpdateSource,                  // update source (default none; point JsonlSdeSource at a jsonl mirror)
  sdeUpdateUrl,                     // default mirror URL the update card prefills
  defaultMarketRegionId,            // initial default market region for esi_market_prices
}
```

## Settings cards

The web half contributes the two cards to the bundle's own page in the **Plugins** panel (`plugins.bundle.config`, keyed by package name — this is what makes the page treat the bundle as configurable) and to a tab in **Settings → Plugins**.

- **SDE update** — download-URL field, update and rollback buttons, live phase/progress/error.
- **EVE account** — EVE SSO login (the card publishes the login URL, the user opens it), authorized characters with per-character revoke, default market-region picker.

How it works in DSH 0.2.2:

- DSH 0.2 derives settings forms from each plugin entry's `Config`; the old ad-hoc settings namespaces are gone, and transient state must not be written into the user's profile.
- The host therefore exposes a small same-origin JSON bridge at `/dsh-esi/api/*` (`src/ui/bridge.ts`) over the Web server's route table. The cards poll one state object once per second while visible and POST one action per gesture; action responses already carry the fresh state.
- The same operations back the tools: the card's update/rollback calls the shared `SdeUpdateRunner` that `sde_update` uses, so chat and card never race on the data root. Account login reuses `EsiaAuthService`.
- The bridge is optional: headless profiles and Desktop compositions without a Web server never mount it, and tools keep working. Writes are refused cross-origin and require a JSON body; the surface is local-only.
- The browser half uses only React from the module table and registers into `settings.plugins.tab`; every other package import is type-only.

## SDE data

- Version directories are self-contained: `data/<version>/` (jsonl + `_sde.jsonl` + `manifest.json` + `sde.db`); `data/current` is a symlink to the active version. The jsonl files are the source of truth; `sde.db` is a derived SQLite read store (`node:sqlite`, rebuildable).
- After first use or a data change, run `node scripts/build-manifest.mjs` to generate the manifest + `sde.db` (~11 s for the 553 MB full set; all 101 tables queryable with indexes).
- Updating (two ways):
  1. Configured source: set `sdeUpdateSource: new JsonlSdeSource({ baseUrl })`, then the model calls `sde_update` (first `confirm=false` for a plan, then `confirm=true` once the user agrees).
  2. Arbitrary download URL: pass `url` to `sde_update`, or paste it into the settings card. Both layouts work: the **official CCP static-data jsonl export** (`_sde.jsonl` + one `.jsonl` per table, e.g. `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-<build>-jsonl.zip`) and a **jsonl mirror zip** that adds `manifest.json`. No preconfigured source needed; the dry-run HEAD-probes reachability and size, then download → validate (zip integrity / zip-slip guard / payload validation) → build index → atomic switch, keeping the previous version for rollback.
- Error handling: URL validation (http/https only), connect failures / timeouts / HTTP statuses / interrupted downloads classified with automatic retries for transient faults, size caps, disk-full hints. Every error carries a stable `code` plus a localized message (see `SdeZipError` in `src/sde/zip-source.ts`); statuses travel to the card as `messageKey` + `messageParams` and are translated in the active UI language.
- The official SDE zip (CSV/YAML) converter is a TODO: implement `OfficialZipSdeSource` against the `SdeUpdateSource` interface.

## Development

```bash
pnpm install                      # npm-published DSH 0.2.2 packages; no harness checkout needed
pnpm run gen                      # regenerate the endpoint catalog from public/json/esi.json
node scripts/build-manifest.mjs   # build the SDE manifest + index
pnpm test                         # tests (99 cases, mock servers, real Web server, no network)
pnpm run typecheck                # tsc over host + browser halves
pnpm run build                    # tsdown → lib/index.js + lib/client.js
node scripts/verify-client.mjs    # built browser bundle: loader id, slot, render
node scripts/smoke.mjs            # offline full-pipeline smoke (mocked; needs data/ in place)
node scripts/e2e-real.mjs         # real-network e2e (CN public endpoints; needs external network)
node scripts/acceptance.mjs       # live `dsh web` mount + bridge check (needs `dsh` on PATH)
```

## Build & release

```bash
pnpm run build      # tsdown build to lib/ (host ESM: peers external, fflate inlined, node: builtins external; browser CJS closure)
pnpm pack           # local tarball inspection (files whitelist: lib/ + cordis.patch.yml + README + LICENSE + package.json)
```

- The root `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`: the package is a standard **bundle**, so `dsh plugin add` inserts the plugin row into the profile layer by package name; the browser half is auto-discovered from the same manifest's `dsh.client` declaration (no separate row needed).
- `engines.dsh` is `^0.2.2-rc.5`. DSH reads that range alone for compatibility, so widen it deliberately when a release supports more DSH versions.
- The `prepare` hook is `tsdown`: auto-builds on git/path installs; `lib/` stays out of git (see .gitignore).
- Engine requires `node >= 24.9`.
- **Release shape**: the community plugin market validates the root `package.json`'s `dsh.bundle.patch` (declared, see above). For internal use, `git tag -a v0.2.1` then `dsh plugin add` (a git URL, local path, or tarball all work); publishing to npm requires `npm publish --access public` under the `@dsh-esi` org, and the tarball already contains `cordis.patch.yml`.
- **No data in the package**: `data/` is in .gitignore and not on the files whitelist; consumers must obtain SDE data themselves after install (see "SDE data" above).

## Debugging in the DSH GUI

The overlay in `scripts/web-patch.yml` mounts the built host half by absolute path, so the real loader runs it without touching the harness workspace:

```bash
pnpm run build
DSH_HOME=$PWD/.tmp/run-home dsh web --patch "$PWD/scripts/web-patch.yml" --no-open --port 3081
node scripts/acceptance.mjs      # boots the same composition on a random port and checks the bridge
```

A path row carries no package manifest, so the client-module scan does not pick up the browser half. To verify the `EVE ESI` tab, install the package into a throwaway profile:

```bash
DSH_HOME=/tmp/dsh-esi-home dsh plugin --profile web add /home/alex/project/dsh-esi
DSH_HOME=/tmp/dsh-esi-home dsh web --no-open
```

The cards appear on the bundle's page in the Plugins panel; the same cards are also under Settings → Plugins. `sde_update` / `sde_rollback` / `esi_authorize` remain the agent-side entry points and share the same operations.

## Migration to DSH 0.2.2

- **Tool execution**: DSH 0.2 moved execution modes into explicit executor plugins, and `ToolsService.execute` now takes a batch of model calls. The tests and scripts mount `@deepseek-ai/dsh-tool-executor-native` and use the batch protocol.
- **Values**: `JsonValue` moved to `@deepseek-ai/dsh-util-values`; `dsh-tools` no longer exports it.
- **Settings**: the ad-hoc `settingsNamespace` / `settingsScope` channel was removed. User-editable values are plugin `Config`; live card state now uses the host JSON bridge described above.
- **Browser half**: `@deepseek-ai/dsh-client-runtime` no longer exists; `ClientContext` is Cordis `Context`, and the old `settings.plugin.item` slot became `settings.plugins.tab` (`settings.section` for a whole page). The tab registers there with a localized label thunk.
- **Compatibility**: `engines.dsh` decides, Node 24.9+ is required, and the Web profile runs `webStartup` instead of `webRuntime` (no overlay rows are needed for the listener).

## Status

| Phase | Status |
|---|---|
| Catalog codegen (204 endpoints) | ✅ |
| ESI client layer (auth / rate limit / pagination / cache / errors) | ✅ |
| Tool surface (search / call / on-demand materialization) | ✅ |
| EVE SSO OAuth + write approval gate | ✅ |
| SDE query + user-triggered update/rollback | ✅ |
| Settings cards (SDE + account) on the 0.2.2 bridge | ✅ |
| Real-network e2e | ✅ |
| Official SDE zip converter | TODO |

---

中文版：[README.zh.md](README.zh.md)
