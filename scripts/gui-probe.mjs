/**
 * GUI-integration probe: boot the REAL `dsh web` composition (profile bundles
 * + scripts/web-patch.yml overlay) through the CLI's own runProfile, settle the
 * loader, then drive the ESI plugin's tools in-process.
 *
 * This is the same loader/patch path the live GUI at :3080 uses — the only
 * difference is this process inspects the mounted runtime instead of a browser.
 *
 * Run from the harness root (all paths are absolute):
 *   DSH_HOME=/home/alex/project/dsh-esi/.dsh-home \
 *     node --import tsx/esm /home/alex/project/dsh-esi/scripts/gui-probe.mjs
 *
 * DSH_ESI_PATCH overrides the overlay file (default: scripts/web-patch.yml,
 * which mounts src/index.ts). Point it at a patch that mounts lib/index.js to
 * acceptance-test the built release artifact through the real loader.
 */
import { runProfile } from 'file:///home/alex/project/deepseek-harness/apps/cli/src/profile-boot.ts'
import { loadLayeredEnv } from 'file:///home/alex/project/deepseek-harness/packages/boot/app-boot/src/index.ts'

const PATCH = process.env.DSH_ESI_PATCH ?? '/home/alex/project/dsh-esi/scripts/web-patch.yml'

function fail(message) {
  console.error(`GUI PROBE FAIL: ${message}`)
  process.exit(1)
}

const exec = (name, args) => ({
  callId: `probe-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
})

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'web',
  patchFiles: [PATCH],
  args: [],
})

// Settlement: wait for the loader tree (plugin rows included) to finish mounting.
const loader = ctx.get('loader')
if (loader === undefined) fail('no loader service after boot')
try {
  await loader.await()
} catch (error) {
  fail(`loader tree failed to settle: ${error.message}`)
}

const tools = ctx.get('tools')
if (tools === undefined) fail('no tools service after boot')

// 1. esi_status — the plugin's orientation tool; proves the plugin mounted.
const status = await tools.execute(exec('esi_status', {}))
if (status.isError) fail(`esi_status errored: ${JSON.stringify(status.error)}`)
if (status.value.plugin !== 'dsh-esi' || status.value.endpointCount !== 204) {
  fail(`esi_status unexpected: ${JSON.stringify(status.value).slice(0, 200)}`)
}
console.log('esi_status ok —', status.value.endpointCount, 'endpoints,', status.value.activeServer.id, '| tools visible:', status.value.authedEndpointCount, 'authed')

// 2. esi_endpoint_search — catalog search through the mounted tool.
const search = await tools.execute(exec('esi_endpoint_search', { query: 'market orders' }))
if (search.isError) fail(`esi_endpoint_search errored: ${JSON.stringify(search.error)}`)
console.log('esi_endpoint_search ok —', search.value.count, 'matches')

// 3. esi_call against the REAL CN mirror (public endpoint) — proves the client,
//    server profile and transport are wired through the harness-mounted plugin.
const call = await tools.execute(exec('esi_call', { operation_id: 'get_status' }))
if (call.isError) fail(`esi_call errored: ${JSON.stringify(call.error)}`)
console.log('esi_call ok — players', call.value.data.players, '| server_version', call.value.data.server_version)

// 4. sde_query against the plugin's real data root (resolved relative to the
//    harness-mounted entry) — proves ../data resolves from the loaded module.
const sde = await tools.execute(exec('sde_query', { table: 'types', search_text: 'rifter', limit: 1 }))
if (sde.isError) fail(`sde_query errored: ${JSON.stringify(sde.error)}`)
console.log('sde_query ok —', sde.value.count, 'matches, engine', sde.value.meta.engine)

console.log('GUI PROBE PASS')
await shutdown.shutdown(0)
process.exit(0)
