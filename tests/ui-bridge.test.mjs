/**
 * Browser-bridge tests: the Host JSON surface the settings cards poll.
 *
 * The bridge is the 0.2 replacement for the removed ad-hoc settings
 * namespaces. These tests mount the real Web server, drive the real routes
 * over HTTP, and use a fake auth/SDE seam so no network or token store is
 * involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountUi } from '../src/account/account-state.ts'
import { SdeUpdateRunner } from '../src/sde/runner.ts'
import { EsiUiBridge } from '../src/ui/bridge.ts'

const CHARACTER = {
  server: 'cn',
  characterId: 42,
  characterName: 'Bridge Pilot',
  accessToken: 'token',
  scopes: ['esi-assets.read_assets.v1'],
  expiresAt: Date.now() + 3600_000,
  updatedAt: Date.now(),
}

function fakeAuth() {
  const accounts = [CHARACTER]
  return {
    accounts,
    listAccounts() { return accounts },
    deauthorize(characterId) {
      const index = characterId === undefined ? 0 : accounts.findIndex((entry) => entry.characterId === characterId)
      if (index < 0) return []
      return accounts.splice(index, characterId === undefined ? accounts.length : 1).map((entry) => entry.characterName)
    },
    async authorize(_scopes, _waitMs, _signal, onFlowStart) {
      onFlowStart?.('https://login.eve.example/authorize?state=abc')
      await new Promise((resolve) => setTimeout(resolve, 5))
      accounts.push({ ...CHARACTER, characterId: 43, characterName: 'Second Pilot' })
      return {
        status: 'authorized',
        characterId: 43,
        characterName: 'Second Pilot',
        scopes: [...CHARACTER.scopes],
        tokenExpiresAt: CHARACTER.expiresAt,
        server: 'cn',
      }
    },
  }
}

const fakeSde = {
  querySync() { throw new Error('no SDE in tests') },
}

/** Boot a real Web server plus the plugin bridge; returns its origin and teardown. */
async function boot(prepare) {
  const root = new Context()
  const fiber = await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-esi-bridge-'))
  if (prepare !== undefined) prepare(dataRoot)
  const runner = new SdeUpdateRunner({ dataRoot })
  const account = new AccountUi({
    auth: fakeAuth(),
    sde: fakeSde,
    oauthWaitMs: 500,
    defaultRegionId: undefined,
  })
  const bridge = new EsiUiBridge({ runner, account })
  bridge.attach(root)
  // `ctx.inject` resolves the Web server on the next microtask turn.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const origin = root.webServer.getOrigin()
  return {
    origin,
    root,
    dataRoot,
    async close() {
      await fiber.dispose()
      rmSync(dataRoot, { recursive: true, force: true })
    },
  }
}

async function state(origin) {
  const response = await fetch(`${origin}/dsh-esi/api/state`)
  assert.equal(response.status, 200)
  return response.json()
}

async function post(origin, path, body, headers = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
}

test('bridge state exposes SDE, characters, regions, and the default region', async () => {
  const runtime = await boot()
  try {
    const body = await state(runtime.origin)
    assert.equal(body.ok, true)
    assert.equal(body.state.sde.available, true)
    assert.equal(body.state.account.characters.length, 1)
    assert.equal(body.state.account.characters[0].characterName, 'Bridge Pilot')
    assert.ok(body.state.account.regions.some((region) => region.id === 10000002))
    assert.equal(body.state.account.defaultRegionId, undefined)
    assert.equal(body.state.sde.status.phase, 'idle')

    const write = await post(runtime.origin, '/dsh-esi/api/account/region', { regionId: 10000043 })
    assert.equal(write.status, 200)
    const after = await write.json()
    assert.equal(after.state.account.defaultRegionId, 10000043)

    const unknown = await post(runtime.origin, '/dsh-esi/api/account/region', { regionId: 1 })
    assert.equal(unknown.status, 400)
    assert.equal((await unknown.json()).error.code, 'REGION_UNKNOWN')

    const cleared = await post(runtime.origin, '/dsh-esi/api/account/region', { regionId: null })
    assert.equal(cleared.status, 200)
    assert.equal((await cleared.json()).state.account.defaultRegionId, undefined)
  } finally {
    await runtime.close()
  }
})

test('bridge login publishes the URL and the settled character list', async () => {
  const runtime = await boot()
  try {
    const started = await post(runtime.origin, '/dsh-esi/api/account/login')
    assert.equal(started.status, 202)

    let body = await state(runtime.origin)
    for (let attempt = 0; attempt < 50 && body.state.account.status.phase !== 'done'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      body = await state(runtime.origin)
    }
    assert.equal(body.state.account.status.phase, 'done')
    assert.equal(body.state.account.status.messageKey, 'status.authorized')
    assert.equal(body.state.account.characters.length, 2)
  } finally {
    await runtime.close()
  }
})

test('bridge refuses a malformed characterId instead of revoking every character', async () => {
  const runtime = await boot()
  try {
    const invalid = await post(runtime.origin, '/dsh-esi/api/account/deauthorize', { characterId: 'all' })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error.code, 'CHARACTER_INVALID')
    const body = await state(runtime.origin)
    assert.equal(body.state.account.characters.length, 1)
  } finally {
    await runtime.close()
  }
})

test('bridge serializes rollback so a double click cannot undo two builds', async () => {
  const runtime = await boot((dataRoot) => {
    for (const build of [2, 1]) {
      const dir = join(dataRoot, `sde-${build}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ buildNumber: build, tables: {} }))
    }
    symlinkSync('sde-2', join(dataRoot, 'current'))
  })
  try {
    const [first, second] = await Promise.all([
      post(runtime.origin, '/dsh-esi/api/sde/rollback'),
      post(runtime.origin, '/dsh-esi/api/sde/rollback'),
    ])
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    const body = await state(runtime.origin)
    // Exactly one rollback: 2 -> 1, not 2 -> 1 -> (no candidate / error).
    assert.equal(body.state.sde.status.phase, 'done')
    assert.equal(body.state.sde.status.currentBuild, 1)
    assert.equal(readlinkSync(join(runtime.dataRoot, 'current')), 'sde-1')
  } finally {
    await runtime.close()
  }
})

test('bridge deauthorize removes one character', async () => {
  const runtime = await boot()
  try {
    const removed = await post(runtime.origin, '/dsh-esi/api/account/deauthorize', { characterId: 42 })
    assert.equal(removed.status, 200)
    const body = await removed.json()
    assert.equal(body.state.account.characters.length, 0)
  } finally {
    await runtime.close()
  }
})

test('bridge reports an empty update URL as a typed SDE error', async () => {
  const runtime = await boot()
  try {
    const started = await post(runtime.origin, '/dsh-esi/api/sde/update', {})
    assert.equal(started.status, 202)
    const body = await state(runtime.origin)
    assert.equal(body.state.sde.status.phase, 'error')
    assert.equal(body.state.sde.status.error.code, 'URL_EMPTY')
  } finally {
    await runtime.close()
  }
})

test('bridge refuses cross-origin writes and unknown paths', async () => {
  const runtime = await boot()
  try {
    const crossOrigin = await post(runtime.origin, '/dsh-esi/api/account/login', {}, {
      origin: 'https://evil.example',
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await crossOrigin.json()).error.code, 'CROSS_ORIGIN')

    const missing = await fetch(`${runtime.origin}/dsh-esi/api/nope`)
    assert.equal(missing.status, 404)

    const wrongMethod = await fetch(`${runtime.origin}/dsh-esi/api/state`, { method: 'DELETE' })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await runtime.close()
  }
})
