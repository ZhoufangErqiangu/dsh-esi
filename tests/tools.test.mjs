/**
 * Tool-surface tests: esi_endpoint_search, esi_call, and — the core of the
 * design — esi_endpoint_load materializing native tools into an agent-scoped
 * layer via the real cordis registry (scoped registration is agent-local,
 * auto-disposed, and invisible outside the agent).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { EsiaClient } from '../src/esia-client.ts'
import { ENDPOINT_INDEX, ENDPOINTS, SERVERS } from '../src/generated/catalog.ts'
import { createSearchTool } from '../src/tools/search.ts'
import { createCallTool } from '../src/tools/call.ts'
import { createLoadTool, buildEndpointTool } from '../src/tools/load.ts'

const CN_BASE = SERVERS.cn.esiBase

function startMock(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        handler(
          { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() },
          {
            status(code) { res.statusCode = code; return this },
            header(name, value) { res.setHeader(name, value); return this },
            json(data) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) },
            text(value) { res.end(value ?? '') },
          },
        )
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function makeClient(port) {
  return new EsiaClient({
    server: 'cn',
    ratePerSecond: 0,
    fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${port}`), init),
  })
}

function execStub(overrides = {}) {
  return {
    callId: `c-${Math.random().toString(36).slice(2)}`,
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Full cordis runtime with an agent-scoped context (mirrors agent-loop setup). */
async function setupRuntime() {
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, { mode: 'native' })
  const agent = { id: 'agent-1' }
  let scope
  // createScope must run inside a fiber that declares the services the agent
  // scope chain must resolve (same idiom as the harness's mintAgentScope).
  await root.plugin(Object.assign(
    (inner) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] },
  ))
  agent.ctx = scope.ctx
  return { root, agent }
}

// ---- esi_endpoint_search ---------------------------------------------------

test('search finds endpoints by keyword with the exact operationId', async () => {
  const tool = createSearchTool()
  const result = await tool.execute({ query: 'character assets' }, execStub())
  assert.equal(result.count > 0, true)
  const ids = result.matches.map((m) => m.operationId)
  assert.ok(ids.includes('get_characters_character_id_assets'))
  const match = result.matches.find((m) => m.operationId === 'get_characters_character_id_assets')
  assert.deepEqual(match.requiredPathParams, ['character_id'])
  assert.deepEqual(match.scopes, ['esi-assets.read_assets.v1'])
  assert.equal(match.paginated, true)
})

test('search restricts by domain tag', async () => {
  const tool = createSearchTool()
  const result = await tool.execute({ tag: 'Market' }, execStub())
  assert.ok(result.count > 0)
  for (const match of result.matches) {
    assert.ok(match.tags.includes('Market'))
  }
})

test('search with no query and no tag returns the limit', async () => {
  const tool = createSearchTool()
  const result = await tool.execute({ limit: 5 }, execStub())
  assert.equal(result.count, 5)
  assert.equal(result.matches.length, 5)
})

test('search honors the cap', async () => {
  const tool = createSearchTool()
  const result = await tool.execute({ limit: 999 }, execStub())
  assert.ok(result.matches.length <= 30)
})

// ---- esi_call ----------------------------------------------------------------

test('esi_call dispatches any endpoint through the client', async () => {
  const seen = []
  const { server, port } = await startMock((req, reply) => {
    seen.push(req.url)
    reply.status(200).json({ character_id: 42, name: 'Capsuleer' })
  })
  try {
    const client = makeClient(port)
    const tool = createCallTool(client)
    const result = await tool.execute(
      { operation_id: 'get_characters_character_id', path_params: { character_id: 42 } },
      execStub(),
    )
    assert.equal(result.operation_id, 'get_characters_character_id')
    assert.equal(result.data.name, 'Capsuleer')
    assert.equal(result.meta.status, 200)
    assert.match(seen[0], /^\/characters\/42\//)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('esi_call rejects unknown operationIds with guidance', async () => {
  const { server, port } = await startMock(() => { throw new Error('must not hit server') })
  try {
    const client = makeClient(port)
    const tool = createCallTool(client)
    await assert.rejects(
      tool.execute({ operation_id: 'get_does_not_exist' }, execStub()),
      /unknown operationId.*esi_endpoint_search/,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---- esi_endpoint_load (materialization) -------------------------------------

/** Register the plugin's fixed surface onto the root registry (as apply() does). */
function registerFixed(root, client, options = {}) {
  root.tools.register(createSearchTool())
  root.tools.register(createCallTool(client))
  root.tools.register(createLoadTool(client, options))
}

test('materialized tools are registered in the agent scope and invisible globally', async () => {
  const { root, agent } = await setupRuntime()
  const { server, port } = await startMock((req, reply) => {
    reply.status(200).json({ character_id: 7, name: 'Scoped' })
  })
  try {
    const client = makeClient(port)
    registerFixed(root, client, { cap: 5 })

    // Load one endpoint into the agent scope.
    const loadResult = await root.tools.execute(execStub({
      name: 'esi_endpoint_load',
      agent,
      arguments: { operation_ids: ['get_characters_character_id'] },
    }))
    assert.equal(loadResult.isError, false, JSON.stringify(loadResult.error))
    assert.equal(loadResult.value.loaded[0].name, 'esi_get_characters_character_id')
    assert.equal(loadResult.value.count, 1)

    // The materialized tool executes for this agent (scoped lookup succeeds).
    const callResult = await root.tools.execute(execStub({
      name: 'esi_get_characters_character_id',
      agent,
      arguments: { character_id: 7 },
    }))
    assert.equal(callResult.isError, false, JSON.stringify(callResult.error))
    assert.equal(callResult.value.data.name, 'Scoped')

    // The same tool is NOT reachable outside the agent scope.
    const globalResult = await root.tools.execute(execStub({
      name: 'esi_get_characters_character_id',
      arguments: { character_id: 7 },
    }))
    assert.equal(globalResult.isError, true)
    assert.equal(globalResult.error.info.code, 'UNKNOWN_TOOL')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('materialized tools survive via their own definition (unit level)', async () => {
  const { server, port } = await startMock((_req, reply) => {
    reply.status(200).json([{ item_id: 1 }])
  })
  try {
    const client = makeClient(port)
    const tool = buildEndpointTool(client, ENDPOINTS[ENDPOINT_INDEX.get_characters_character_id_assets])
    const result = await tool.execute({ character_id: 1 }, execStub())
    assert.equal(result.data.length, 1)
    assert.equal(result.operation_id, 'get_characters_character_id_assets')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('loading a whole tag materializes every endpoint of that tag', async () => {
  const { root, agent } = await setupRuntime()
  const { server, port } = await startMock((_req, reply) => reply.status(200).json([]))
  try {
    const client = makeClient(port)
    registerFixed(root, client, { cap: 100 })
    const result = await root.tools.execute(execStub({
      name: 'esi_endpoint_load',
      agent,
      arguments: { tag: 'Insurance' },
    }))
    assert.equal(result.isError, false, JSON.stringify(result.error))
    // Insurance tag has exactly one endpoint in the CN spec.
    assert.equal(result.value.loaded.length, 1)
    assert.equal(result.value.loaded[0].operationId, 'get_insurance_prices')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('cap enforcement and unload free slots', async () => {
  const { root, agent } = await setupRuntime()
  const { server, port } = await startMock((_req, reply) => reply.status(200).json({}))
  try {
    const client = makeClient(port)
    registerFixed(root, client, { cap: 1 })

    const first = await root.tools.execute(execStub({
      name: 'esi_endpoint_load',
      agent,
      arguments: { operation_ids: ['get_alliances'] },
    }))
    assert.equal(first.value.count, 1)

    // Second load exceeds the cap.
    const over = await root.tools.execute(execStub({
      name: 'esi_endpoint_load',
      agent,
      arguments: { operation_ids: ['get_insurance_prices'] },
    }))
    assert.equal(over.isError, true)
    assert.match(over.error.message, /cap reached/)

    // Unload frees the slot.
    const unloaded = await root.tools.execute(execStub({
      name: 'esi_endpoint_load',
      agent,
      arguments: { unload: ['get_alliances'] },
    }))
    assert.equal(unloaded.isError, false, JSON.stringify(unloaded.error))
    assert.equal(unloaded.value.count, 0)

    // The unloaded tool is no longer reachable for the agent.
    const gone = await root.tools.execute(execStub({
      name: 'esi_get_alliances',
      agent,
      arguments: {},
    }))
    assert.equal(gone.isError, true)
    assert.equal(gone.error.info.code, 'UNKNOWN_TOOL')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
