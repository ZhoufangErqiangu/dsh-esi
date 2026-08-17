/**
 * Auth tests: token store persistence/selection, the loopback SSO flow
 * (browser simulated by direct fetches to the callback/capture endpoints),
 * and the composed EsiaAuthService.authorize with a mocked /oauth/verify.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EsiaAuthService } from '../src/auth/service.ts'
import { TokenStore } from '../src/auth/token-store.ts'
import { startAuthorizeFlow, verifyCharacter } from '../src/auth/flow.ts'
import { SERVERS } from '../src/generated/catalog.ts'

const LOGIN_BASE = SERVERS.cn.loginBase

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-auth-'))
  return { dir, path: join(dir, 'auth.json') }
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

// ---- TokenStore --------------------------------------------------------------

test('token store persists across instances and upserts by (server, character)', () => {
  const { dir, path } = tmpStore()
  try {
    const store = new TokenStore(path)
    store.put({
      server: 'cn', characterId: 1, characterName: 'Alpha', accessToken: 't1',
      scopes: ['esi-assets.read_assets.v1'], expiresAt: Date.now() + 3600e3, updatedAt: 100,
    })
    store.put({
      server: 'cn', characterId: 1, characterName: 'Alpha', accessToken: 't1b',
      scopes: ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1'], expiresAt: Date.now() + 3600e3, updatedAt: 200,
    })
    store.put({
      server: 'global', characterId: 2, characterName: 'Beta', accessToken: 't2',
      scopes: ['esi-assets.read_assets.v1'], expiresAt: Date.now() + 3600e3, updatedAt: 300,
    })
    // New instance reads the persisted file.
    const reloaded = new TokenStore(path)
    assert.equal(reloaded.list('cn').length, 1, 'upsert must replace by character id')
    assert.equal(reloaded.get('cn', 1).accessToken, 't1b')
    assert.equal(reloaded.list('global').length, 1)
    assert.equal(reloaded.list().length, 2)
    assert.equal(reloaded.remove('cn', 1), true)
    assert.equal(reloaded.get('cn', 1), undefined)
    assert.equal(reloaded.remove('cn', 1), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolve picks the token covering all required scopes, preferring configured character then fewest extras', () => {
  const { dir } = tmpStore()
  const store = new TokenStore(join(dir, 'store.json'))
  const now = Date.now()
  store.put({
    server: 'cn', characterId: 11, characterName: 'Few', accessToken: 'few',
    scopes: ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1'], expiresAt: now + 3600e3, updatedAt: 500,
  })
  store.put({
    server: 'cn', characterId: 22, characterName: 'Pref', accessToken: 'pref',
    scopes: ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1', 'esi-wallet.read_character_wallet.v1'],
    expiresAt: now + 3600e3, updatedAt: 600,
  })
  assert.equal(store.resolve('cn', ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1']), 'few', 'fewest extras wins')
  assert.equal(store.resolve('cn', ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1'], 22), 'pref', 'preferred character wins')
  assert.equal(store.resolve('cn', ['esi-mail.read_mail.v1']), undefined, 'uncovered scope resolves nothing')
  assert.equal(store.resolve('global', ['esi-assets.read_assets.v1']), undefined, 'server isolation')
})

test('resolve ignores expired tokens', () => {
  const { dir } = tmpStore()
  const store = new TokenStore(join(dir, 'store.json'))
  store.put({
    server: 'cn', characterId: 1, characterName: 'Old', accessToken: 'old',
    scopes: ['esi-assets.read_assets.v1'], expiresAt: Date.now() - 1000, updatedAt: 1,
  })
  assert.equal(store.resolve('cn', ['esi-assets.read_assets.v1']), undefined)
})

// ---- SSO flow (loopback, browser simulated) -----------------------------------

test('startAuthorizeFlow builds a stateful URL and resolves via /capture', async () => {
  const port = await freePort()
  const flow = startAuthorizeFlow({
    loginBase: LOGIN_BASE,
    clientId: 'test-client',
    redirectUri: `http://127.0.0.1:${port}/callback`,
    scopes: ['esi-assets.read_assets.v1'],
  })
  try {
    const url = new URL(flow.url)
    assert.equal(url.searchParams.get('response_type'), 'token')
    assert.equal(url.searchParams.get('client_id'), 'test-client')
    assert.equal(url.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/callback`)
    assert.equal(url.searchParams.get('scope'), 'esi-assets.read_assets.v1')
    const state = url.searchParams.get('state')
    assert.ok(state && state.length >= 16)

    // Browser simulation: load the capture page, then POST the fragment.
    const page = await fetch(`http://127.0.0.1:${port}/callback`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /fetch\('\/capture'/)

    const capture = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, access_token: 'tok-123', expires_in: 1200 }),
    })
    assert.equal(capture.status, 200)
    const outcome = await flow.result
    assert.equal(outcome.accessToken, 'tok-123')
    assert.equal(outcome.expiresIn, 1200)
  } finally {
    flow.close()
  }
})

test('startAuthorizeFlow rejects on error fragments and state mismatches', async () => {
  const port = await freePort()
  const flow = startAuthorizeFlow({
    loginBase: LOGIN_BASE,
    clientId: 'test-client',
    redirectUri: `http://127.0.0.1:${port}/callback`,
    scopes: [],
  })
  try {
    const state = new URL(flow.url).searchParams.get('state')
    // Wrong state → 400 and the flow stays pending.
    const bad = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'wrong', access_token: 'x' }),
    })
    assert.equal(bad.status, 400)
    // Correct state with an error → flow rejects. Attach the assertion BEFORE
    // triggering the rejection so it is never unhandled.
    const rejection = assert.rejects(flow.result, /access_denied.*user said no/)
    const denied = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, error: 'access_denied', error_description: 'user said no' }),
    })
    assert.equal(denied.status, 200)
    await rejection
  } finally {
    flow.close()
  }
})

test('verifyCharacter parses the EVE SSO verify payload', async () => {
  const { server, port, seen } = await startVerifyMock()
  try {
    const verified = await verifyCharacter(LOGIN_BASE, 'tok-x', (url, init) =>
      fetch(url.replace(LOGIN_BASE, `http://127.0.0.1:${port}`), init))
    assert.equal(seen[0], 'Bearer tok-x')
    assert.equal(verified.characterId, 2112628268)
    assert.equal(verified.characterName, 'Test Pilot')
    assert.deepEqual(verified.scopes, ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

function startVerifyMock() {
  const seen = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        CharacterID: 2112628268,
        CharacterName: 'Test Pilot',
        ExpiresOn: Date.now() + 3600e3,
        Scopes: 'esi-assets.read_assets.v1 esi-skills.read_skills.v1',
        TokenType: 'Bearer',
      }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

// ---- EsiaAuthService.authorize end to end --------------------------------------

test('authorize completes the full flow, persists the token, and resolves it via tokenProvider', async () => {
  const { dir, path } = tmpStore()
  const store = new TokenStore(path)
  const port = await freePort()
  const verify = await startVerifyMock()
  const { seen } = verify
  let flowUrl = ''
  const auth = new EsiaAuthService({
    serverId: 'cn',
    store,
    clientIds: { cn: 'test-client' },
    callbackHost: '127.0.0.1',
    callbackPort: port,
    fetchImpl: (url, init) => fetch(url.replace(LOGIN_BASE, `http://127.0.0.1:${verify.port}`), init),
    onFlowStart: (url) => { flowUrl = url },
  })
  try {
    const pending = auth.authorize(['esi-assets.read_assets.v1'], 15_000)
    const url = new URL(flowUrl)
    const state = url.searchParams.get('state')
    const capture = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, access_token: 'tok-final', expires_in: 3600 }),
    })
    assert.equal(capture.status, 200)
    const result = await pending
    assert.equal(seen[0], 'Bearer tok-final')
    assert.equal(result.status, 'authorized')
    assert.equal(result.characterId, 2112628268)
    assert.equal(result.characterName, 'Test Pilot')
    assert.deepEqual(result.scopes, ['esi-assets.read_assets.v1', 'esi-skills.read_skills.v1'])

    const stored = store.get('cn', 2112628268)
    assert.equal(stored.accessToken, 'tok-final')
    assert.equal(await auth.resolveToken(['esi-assets.read_assets.v1']), 'tok-final')
    assert.deepEqual(auth.listAccounts().map((token) => token.characterName), ['Test Pilot'])
  } finally {
    await new Promise((resolve) => verify.server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authorize fails loudly without a configured client id', async () => {
  const auth = new EsiaAuthService({
    serverId: 'cn',
    store: new TokenStore('/nonexistent/x.json'),
    clientIds: {},
  })
  await assert.rejects(auth.authorize(['esi-assets.read_assets.v1'], 5000), /client id/)
})

test('authorize validates scope names against the catalog', async () => {
  const auth = new EsiaAuthService({
    serverId: 'cn',
    store: new TokenStore('/nonexistent/x.json'),
    clientIds: { cn: 'c' },
  })
  await assert.rejects(auth.authorize(['esi-totally.fake.v1'], 5000), /unknown EVE SSO scope/)
})
