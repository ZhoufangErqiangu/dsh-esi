/**
 * End-to-end smoke test: boot the actual plugin (`apply`) on a real cordis
 * runtime with the real dsh-tools registry, then drive the whole tool surface
 * against a local mock ESI server:
 *   esi_status → esi_endpoint_search → esi_call → esi_endpoint_load →
 *   materialized native tool (agent scope) → invisible outside the scope.
 * Not part of the committed node:test suite (needs the harness checkout).
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createServer } from 'node:http'
import { apply, name } from './src/index.ts'
import { SERVERS } from './src/generated/catalog.ts'

const CN_BASE = SERVERS.cn.esiBase

function assert(condition, message) {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`)
}

// Local mock ESI server.
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (/^\/characters\/42\/assets\//.test(req.url ?? '')) {
    res.end(JSON.stringify([{ item_id: 1, type_id: 34, quantity: 5 }]))
  } else if (/^\/characters\/42\//.test(req.url ?? '')) {
    res.end(JSON.stringify({ character_id: 42, name: 'Smoke Capsuleer' }))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found in smoke mock' }))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const root = new Context()
await root.plugin(SystemPrompt, {})
await root.plugin(ToolRuntime, { mode: 'native' })

apply(root, {
  server: 'cn',
  ratePerSecond: 0,
  fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${port}`), init),
})

const exec = (name_, arguments_, agent) => ({
  callId: `smoke-${Math.random().toString(36).slice(2)}`,
  name: name_,
  arguments: arguments_,
  signal: new AbortController().signal,
  ...(agent !== undefined ? { agent } : {}),
})

console.log('plugin name:', name)

// 1. status
const status = await root.tools.execute(exec('esi_status', {}))
assert(!status.isError, JSON.stringify(status.error))
assert(status.value.endpointCount === 204, `endpointCount ${status.value.endpointCount}`)
assert(status.value.activeServer.id === 'cn', 'active server should be cn')
console.log('esi_status ok —', status.value.endpointCount, 'endpoints, server', status.value.activeServer.id)

// 2. search
const search = await root.tools.execute(exec('esi_endpoint_search', { query: 'character assets' }))
assert(!search.isError, JSON.stringify(search.error))
const found = search.value.matches.find((m) => m.operationId === 'get_characters_character_id_assets')
assert(found !== undefined, 'search must find asset endpoint')
console.log('esi_endpoint_search ok —', search.value.count, 'matches')

// 3. call (generic dispatcher)
const call = await root.tools.execute(exec('esi_call', {
  operation_id: 'get_characters_character_id',
  path_params: { character_id: 42 },
}))
assert(!call.isError, JSON.stringify(call.error))
assert(call.value.data.name === 'Smoke Capsuleer', 'dispatcher must hit the mock server')
console.log('esi_call ok —', call.value.data.name, '| meta.status', call.value.meta.status)

// 4. materialize into an agent scope
const agent = { id: 'smoke-agent' }
let scope
await root.plugin(Object.assign(
  (inner) => { scope = createScope(inner, agent) },
  { inject: ['tools', 'systemPrompt'] },
))
agent.ctx = scope.ctx

const load = await root.tools.execute(exec('esi_endpoint_load', { operation_ids: ['get_characters_character_id_assets'] }, agent))
assert(!load.isError, JSON.stringify(load.error))
assert(load.value.loaded.length === 1, 'one tool must be loaded')
console.log('esi_endpoint_load ok —', load.value.loaded[0].name)

// 5. materialized tool executes for the agent
const mat = await root.tools.execute(exec('esi_get_characters_character_id_assets', { character_id: 42 }, agent))
assert(!mat.isError, JSON.stringify(mat.error))
assert(mat.value.data.length === 1, 'materialized tool must call the mock')
console.log('materialized tool ok —', mat.value.data[0].type_id)

// 6. invisible outside the agent scope
const gone = await root.tools.execute(exec('esi_get_characters_character_id_assets', { character_id: 42 }))
assert(gone.isError && gone.error.info.code === 'UNKNOWN_TOOL', 'tool must not leak outside the agent scope')
console.log('scope isolation ok — UNKNOWN_TOOL outside agent')

await new Promise((resolve) => server.close(resolve))
console.log('SMOKE PASS')
process.exit(0)
