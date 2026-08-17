/**
 * End-to-end smoke test: boot the actual plugin (`apply`) on a real cordis
 * runtime with the real dsh-tools registry, then drive the whole surface
 * against local mock servers:
 *   esi_status → search → esi_call → esi_authorize (browser simulated) →
 *   protected esi_call with token attached → materialize → scoped isolation.
 * Not part of the committed node:test suite (needs the harness checkout).
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/index.ts'
import { SERVERS } from '../src/generated/catalog.ts'

const CN_BASE = SERVERS.cn.esiBase
const LOGIN_BASE = SERVERS.cn.loginBase

function assert(condition, message) {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`)
}

// ---- mock ESI server (also echoes the auth header for assets) ----
let seenAuth = []
const esi = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (/^\/characters\/42\/assets\//.test(req.url ?? '')) {
    seenAuth.push(req.headers.authorization)
    res.end(JSON.stringify([{ item_id: 1, type_id: 34, quantity: 5 }]))
  } else if (/^\/characters\/42\//.test(req.url ?? '')) {
    res.end(JSON.stringify({ character_id: 42, name: 'Smoke Capsuleer' }))
  } else {
    res.end(JSON.stringify({ ok: true, url: req.url }))
  }
})
await new Promise((resolve) => esi.listen(0, '127.0.0.1', resolve))
const esiPort = esi.address().port

// ---- mock SSO verify endpoint ----
const verify = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    CharacterID: 2112628268,
    CharacterName: 'Smoke Pilot',
    ExpiresOn: Date.now() + 3600e3,
    Scopes: 'esi-assets.read_assets.v1',
    TokenType: 'Bearer',
  }))
})
await new Promise((resolve) => verify.listen(0, '127.0.0.1', resolve))
const verifyPort = verify.address().port

// ---- free loopback port for the SSO callback ----
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const callbackPort = probe.address().port
await new Promise((resolve) => probe.close(resolve))

const transport = (url, init) => fetch(
  url.replace(CN_BASE, `http://127.0.0.1:${esiPort}`).replace(LOGIN_BASE, `http://127.0.0.1:${verifyPort}`),
  init,
)

const root = new Context()
await root.plugin(SystemPrompt, {})
await root.plugin(ToolRuntime, { mode: 'native' })

const storeDir = mkdtempSync(join(tmpdir(), 'dsh-esi-smoke-'))
let resolveAuthorizeUrl
const authorizeUrlPromise = new Promise((resolve) => { resolveAuthorizeUrl = resolve })
apply(root, {
  server: 'cn',
  ratePerSecond: 0,
  fetchImpl: transport,
  clientIds: { cn: 'smoke-client-id' },
  callbackHost: '127.0.0.1',
  callbackPort,
  authStorePath: join(storeDir, 'auth.json'),
  onFlowStart: (url) => { resolveAuthorizeUrl(url) },
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
assert(status.value.endpointCount === 204, 'endpoint count')
console.log('esi_status ok —', status.value.endpointCount, 'endpoints,', status.value.authorizedCharacters.length, 'authorized')

// 2. search
const search = await root.tools.execute(exec('esi_endpoint_search', { query: 'character assets' }))
assert(!search.isError, JSON.stringify(search.error))
console.log('esi_endpoint_search ok —', search.value.count, 'matches')

// 3. call (generic dispatcher, public endpoint)
const call = await root.tools.execute(exec('esi_call', {
  operation_id: 'get_characters_character_id',
  path_params: { character_id: 42 },
}))
assert(!call.isError, JSON.stringify(call.error))
assert(call.value.data.name === 'Smoke Capsuleer', 'dispatcher must hit the mock server')
console.log('esi_call ok —', call.value.data.name)

// 4. authorize (browser simulated via the loopback capture)
const authPending = root.tools.execute(exec('esi_authorize', { scopes: ['esi-assets.read_assets.v1'] }))
const authorizeUrl = await authorizeUrlPromise
assert(authorizeUrl !== '', 'onFlowStart must deliver the authorize URL')
const authUrl = new URL(authorizeUrl)
const state = authUrl.searchParams.get('state')
const capture = await fetch(`http://127.0.0.1:${callbackPort}/capture`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state, access_token: 'smoke-token', expires_in: 3600 }),
})
assert(capture.status === 200, 'capture must accept the fragment payload')
const authResult = await authPending
assert(!authResult.isError, JSON.stringify(authResult.error))
assert(authResult.value.status === 'authorized', 'must be authorized')
assert(authResult.value.characterName === 'Smoke Pilot', 'verify must resolve the character')
console.log('esi_authorize ok —', authResult.value.characterName, 'scopes:', authResult.value.scopes.length)

// 5. protected call now attaches the token
const assets = await root.tools.execute(exec('esi_call', {
  operation_id: 'get_characters_character_id_assets',
  path_params: { character_id: 42 },
}))
assert(!assets.isError, JSON.stringify(assets.error))
assert(seenAuth.length === 1 && seenAuth[0] === 'Bearer smoke-token', 'token must be attached')
console.log('protected esi_call ok — Authorization attached')

// 6. accounts
const accounts = await root.tools.execute(exec('esi_accounts', {}))
assert(!accounts.isError, JSON.stringify(accounts.error))
assert(accounts.value.accounts.length === 1, 'one account must be listed')
console.log('esi_accounts ok —', accounts.value.accounts[0].characterName)

// 6b. SDE status + real-data queries (indexed fast path and stream scan)
const sdeStatus = await root.tools.execute(exec('sde_status', {}))
assert(!sdeStatus.isError, JSON.stringify(sdeStatus.error))
assert(sdeStatus.value.buildNumber === 3470007, 'real data build')
assert(sdeStatus.value.manifestPresent === true, 'manifest must exist')
assert(sdeStatus.value.dbPresent === true, 'sde.db must be present')
console.log('sde_status ok — build', sdeStatus.value.buildNumber, '|', sdeStatus.value.tableCount, 'tables, db', sdeStatus.value.dbPresent)

const sdeQuery = await root.tools.execute(exec('sde_query', { table: 'types', search_text: 'rifter', limit: 3, language: 'zh' }))
assert(!sdeQuery.isError, JSON.stringify(sdeQuery.error))
assert(sdeQuery.value.count >= 1, 'rifter must be found')
assert(sdeQuery.value.rows[0].name !== undefined, 'localized name resolved')
console.log('sde_query ok —', sdeQuery.value.count, 'matches, first:', sdeQuery.value.rows[0].name, '(zh), engine:', sdeQuery.value.meta.engine)

// 7. materialize into an agent scope
const agent = { id: 'smoke-agent' }
let scope
await root.plugin(Object.assign(
  (inner) => { scope = createScope(inner, agent) },
  { inject: ['tools', 'systemPrompt'] },
))
agent.ctx = scope.ctx
const load = await root.tools.execute(exec('esi_endpoint_load', { operation_ids: ['get_characters_character_id_assets'] }, agent))
assert(!load.isError, JSON.stringify(load.error))
const mat = await root.tools.execute(exec('esi_get_characters_character_id_assets', { character_id: 42 }, agent))
assert(!mat.isError, JSON.stringify(mat.error))
assert(mat.value.data.length === 1, 'materialized tool must call the mock')
const gone = await root.tools.execute(exec('esi_get_characters_character_id_assets', { character_id: 42 }))
assert(gone.isError && gone.error.info.code === 'UNKNOWN_TOOL', 'must not leak outside the agent scope')
console.log('materialization ok — scoped execution + isolation')

await new Promise((resolve) => esi.close(resolve))
await new Promise((resolve) => verify.close(resolve))
rmSync(storeDir, { recursive: true, force: true })
console.log('SMOKE PASS')
process.exit(0)
