/**
 * Approval-gate tests: mutating ESI calls (POST/PUT/DELETE) — through both the
 * generic dispatcher and materialized tools — must be denied without user
 * approval (no approval service mounted in these tests → ask fails closed),
 * while read (GET) calls pass through untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply } from '../src/index.ts'
import { ENDPOINTS, SERVERS } from '../src/generated/catalog.ts'

const CN_BASE = SERVERS.cn.esiBase

function startMock() {
  return new Promise((resolve) => {
    const hits = []
    const server = createServer((req, res) => {
      hits.push(req.url)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }))
  })
}

function execStub(name, args, agent) {
  return {
    callId: `c-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(agent !== undefined ? { agent } : {}),
  }
}

async function setup(config = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, { mode: 'native' })
  apply(root, config)
  return root
}

function firstMutatingEndpoint() {
  const endpoint = ENDPOINTS.find((candidate) => candidate.method !== 'GET')
  assert.ok(endpoint, 'catalog must contain a non-GET endpoint')
  return endpoint
}

test('mutating esi_call is denied without approval; GET esi_call passes', async () => {
  const mock = await startMock()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-approval-'))
  try {
    const root = await setup({
      server: 'cn',
      ratePerSecond: 0,
      authStorePath: join(dir, 'auth.json'),
      fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${mock.port}`), init),
    })

    // GET passes.
    const read = await root.tools.execute(execStub('esi_call', {
      operation_id: 'get_alliances',
    }))
    assert.equal(read.isError, false, JSON.stringify(read.error))

    // Mutating call is denied BEFORE reaching the network.
    const mutation = firstMutatingEndpoint()
    const write = await root.tools.execute(execStub('esi_call', {
      operation_id: mutation.operationId,
      path_params: {},
      body: {},
    }))
    assert.equal(write.isError, true)
    assert.match(write.error.message, /mutating call/)
    assert.ok(write.error.message.includes(mutation.operationId), 'denial must name the operation')
    assert.deepEqual(mock.hits, ['/alliances/?datasource=serenity'], 'mutating call must never reach the server')
  } finally {
    await new Promise((resolve) => mock.server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('materialized mutating tools are also approval-gated', async () => {
  const mock = await startMock()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-esi-approval-'))
  try {
    const root = await setup({
      server: 'cn',
      ratePerSecond: 0,
      authStorePath: join(dir, 'auth.json'),
      fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${mock.port}`), init),
    })
    const agent = { id: 'approval-agent' }
    let scope
    await root.plugin(Object.assign(
      (inner) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] },
    ))
    agent.ctx = scope.ctx

    const mutation = firstMutatingEndpoint()
    const load = await root.tools.execute(execStub('esi_endpoint_load', {
      operation_ids: [mutation.operationId],
    }, agent))
    assert.equal(load.isError, false, JSON.stringify(load.error))

    // Executing the materialized mutating tool → denied, server untouched.
    const call = await root.tools.execute(execStub(`esi_${mutation.operationId}`, {}, agent))
    assert.equal(call.isError, true)
    assert.match(call.error.message, /mutating call/)
    assert.equal(mock.hits.length, 0)
  } finally {
    await new Promise((resolve) => mock.server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
