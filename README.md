# dsh-esi

A DSH (DeepSeek Harness) plugin bridging the **EVE Online ESI API** (204 endpoints) and **SDE static data** (100+ tables).

Core design: **the endpoint catalog never enters the system prompt**. The always-resident tool surface stays at ~13 tools; the model queries the catalog on demand with `esi_endpoint_search`, calls any endpoint with `esi_call`, and materializes hot endpoints as native tools with `esi_endpoint_load` (agent-scoped, auto-cleaned). See [`docs/design.md`](docs/design.md) for details.

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
| `sde_update` / `sde_rollback` | **User-triggered** SDE update (dry-run by default, executes after confirmation; `url` param updates from any http(s) download address) + rollback |

## Configuration

`apply(ctx, config)`, all fields optional:

```ts
{
  server: 'cn' | 'global',          // default 'cn' (CN Serenity); 'global' is Tranquility
  ratePerSecond, maxPages, maxRetries,   // ESI client (defaults 15 rps / 50 pages / 3 retries)
  maxMaterialized,                  // materialized-tool cap (default 30)
  clientIds: { cn?: string, global?: string },  // EVE developer-app client id (required for esi_authorize)
  callbackHost, callbackPort,       // SSO callback (default 127.0.0.1:32418; register it as a callback URL)
  authStorePath,                    // token storage (default $DSH_HOME/.dsh-esi/auth.json)
  dataRoot,                         // SDE data root (default <package>/data)
  sdeLanguage,                      // default SDE localization language (default en)
  sdeUpdateSource,                  // update source (default none; point JsonlSdeSource at a jsonl mirror)
}
```

## SDE data

- Version directories are self-contained: `data/<version>/` (jsonl + `_sde.jsonl` + `manifest.json` + `sde.db`); `data/current` is a symlink to the active version. The jsonl files are the source of truth; `sde.db` is a derived SQLite read store (`node:sqlite`, rebuildable).
- After first use or a data change, run `node scripts/build-manifest.mjs` to generate the manifest + `sde.db` (~11 s for the 553 MB full set; all 101 tables queryable with indexes).
- Updating (two ways):
  1. Configured source: set `sdeUpdateSource: new JsonlSdeSource({ baseUrl })`, then the model calls `sde_update` (first `confirm=false` for a plan, then `confirm=true` once the user agrees).
  2. Arbitrary download URL: pass `url` to `sde_update` (http/https, pointing at a **jsonl mirror zip** containing `manifest.json` + one `.jsonl` per table). No preconfigured source needed; the dry-run HEAD-probes reachability and size, then download → validate (zip integrity / zip-slip guard / payload validation) → build index → atomic switch, keeping the previous version for rollback.
- Error handling: URL validation (http/https only), connect failures / timeouts / HTTP statuses / interrupted downloads classified with automatic retries for transient faults, size caps, disk-full hints. Every error carries a stable `code` plus a localized message (see `SdeZipError` in `src/sde/zip-source.ts`); statuses are sent over the wire as `messageKey` + `messageParams` and translated by the settings card in the active UI language.
- The official SDE zip (CSV/YAML) converter is a TODO: implement `OfficialZipSdeSource` against the `SdeUpdateSource` interface.
- The settings-page card (download-URL input + update/rollback buttons + live progress/error display) is enabled: dsh-esi is a `dsh.client` dual-face package — the browser bundle (`lib/client.js`) mounts into the web composition via the loader's client-row mechanism, and the cards register under Settings → Plugins → plugin config, keyed by the `dsh-esi` settings namespace (the host `attachSdeGui` registers the namespace and watches trigger fields; status flows back to the browser in real time through `settings/document-updated` events).
  - Mount prerequisite: a sibling `node_modules` in the profile directory (e.g. `~/.dsh/profiles/node_modules/@dsh-esi/plugin-esi`) must symlink to this repository, and the plugin row in `cordis.patch.yml` must use the package name `@dsh-esi/plugin-esi` (not an absolute path); both browser and host resolve through the same package name.
  - Debugging: `node scripts/verify-card.mjs` drives a real browser against a temporary instance on port 3081 through the full card flow (card appears, client-side validation, 404 error, full update, rollback).

## Development

```bash
node scripts/link-harness.mjs     # first run / after clone: link harness prebuilt packages (dsh-scope and 3 more)
node scripts/gen-catalog.mjs      # regenerate the endpoint catalog from public/json/esi.json
node scripts/build-manifest.mjs   # build the SDE manifest + index
node --test 'tests/*.test.mjs'    # tests (88 cases, mock servers, no network)
node scripts/smoke.mjs            # offline full-pipeline smoke (mocked; needs data/ in place)
node scripts/e2e-real.mjs         # real-network e2e (CN public endpoints; needs external network)
```

Type checking (zero install, reuses harness prebuilt types): `tsc -p tsconfig.json` (requires the harness checkout in a sibling directory).

## Build & release

```bash
pnpm run build      # tsdown build to lib/ (single-file ESM: peers external, fflate inlined, node: builtins external)
pnpm pack           # local tarball inspection (files whitelist: lib/ + cordis.patch.yml + README + LICENSE + package.json)
```

- The root `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`: the package is a standard **bundle**, so `dsh plugin add` inserts the plugin row into the profile layer by package name; the browser half is auto-discovered from the same manifest's `dsh.client` declaration (no separate row needed).
- The `prepare` hook is `tsdown`: auto-builds on git/path installs; `lib/` stays out of git (see .gitignore).
- Engine requires `node >= 22.5` (SDE queries depend on `node:sqlite`).
- **Release shape**: the community plugin market validates the root `package.json`'s `dsh.bundle.patch` (declared, see above). For internal use, `git tag -a v0.1.0` then `dsh plugin add` (a git URL, local path, or tarball all work); publishing to npm requires `npm publish --access public` under the `@dsh-esi` org, and the tarball already contains `cordis.patch.yml`. Peer versions (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`) use real semver ranges.
- **No data in the package**: `data/` is in .gitignore and not on the files whitelist; consumers must obtain SDE data themselves after install (see "SDE data" above: `sde_update` with a `url` pointing at a jsonl mirror zip, or place a version dir under `data/` manually + `build-manifest.mjs`).
- Build acceptance: `DSH_ESI_PATCH=<patch pointing at lib/index.js> node scripts/gui-probe.mjs` (mounts lib through the real loader and runs the whole toolchain).

## Debugging in the DSH GUI (working)

The plugin mounts through the **loader by absolute path** without touching the harness workspace (`EntryTree.import(name)` dynamic-imports that path directly; the plugin resolves its own dependencies from its own `node_modules`, SDE data from `src/../data`):

```bash
# 1) Standalone instance (port 3081, coexists with the 3080 production GUI; same loader/patch path):
DSH_HOME=/tmp/dsh-esi-home node --import tsx/esm ../deepseek-harness/apps/cli/src/bin.ts web \
  --patch /home/alex/project/dsh-esi/scripts/web-patch.yml

# 2) In-process probe: real profile composition + the same patch, runs esi_status/search/call/sde_query:
DSH_HOME=/tmp/dsh-esi-home node --import tsx/esm /home/alex/project/dsh-esi/scripts/gui-probe.mjs
```

**Mount into the running :3080 GUI (hot reload, no restart)**: copy the `- insert:` block from `scripts/web-patch.yml` (dropping the webserver row) into `~/.dsh/profiles/web/cordis.patch.yml`; the running instance reloads and mounts the plugin automatically, and removing the block unmounts it. The patch's `name` is an absolute path and must be adjusted per machine.

```yaml
- insert:
    - id: dsh-esi
      name: /home/alex/project/dsh-esi/src/index.ts
      config:
        server: cn
```

## Status

| Phase | Status |
|---|---|
| Catalog codegen (204 endpoints) | ✅ |
| ESI client layer (auth / rate limit / pagination / cache / errors) | ✅ |
| Tool surface (search / call / on-demand materialization) | ✅ |
| EVE SSO OAuth + write approval gate | ✅ |
| SDE query + user-triggered update/rollback | ✅ |
| Real-network e2e | ✅ |
| Official SDE zip converter | TODO |

---

中文版：[README.zh.md](README.zh.md)
