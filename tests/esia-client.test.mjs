/**
 * EsiaClient unit tests against a local mock HTTP server (no real network).
 * The client builds URLs against the real CN profile base and the injected
 * fetchImpl rewrites the host to the mock server, so URL construction,
 * datasource injection, auth headers, retry, pagination, and caching are all
 * exercised end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EsiaClient, EsiaError } from '../src/esia-client.ts'
import { ENDPOINT_INDEX, ENDPOINTS, SERVERS } from '../src/generated/catalog.ts'

function endpoint(operationId) {
  const index = ENDPOINT_INDEX[operationId]
  assert.notEqual(index, undefined, `test endpoint ${operationId} must exist`)
  return ENDPOINTS[index]
}

/** Start a mock ESI server; handler(req, reply) drives the response. */
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

const CN_BASE = SERVERS.cn.esiBase

function makeClient(port, overrides = {}) {
  return new EsiaClient({
    server: 'cn',
    ratePerSecond: 0,
    ...overrides,
    fetchImpl: (url, init) => fetch(url.replace(CN_BASE, `http://127.0.0.1:${port}`), init),
  })
}

async function withServer(handler, fn) {
  const { server, port } = await startMock(handler)
  try {
    return await fn(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('builds the URL with path params substituted and datasource injected', async () => {
  await withServer((req, reply) => {
    assert.equal(req.url, '/characters/95465499/?datasource=serenity')
    reply.status(200).json({ character_id: 95465499, name: 'Test' })
  }, async (port) => {
    const client = makeClient(port)
    const result = await client.call(endpoint('get_characters_character_id'), {
      pathParams: { character_id: 95465499 },
    })
    assert.equal(result.data.character_id, 95465499)
    assert.equal(result.meta.status, 200)
    assert.equal(result.meta.cached, false)
    assert.deepEqual(result.meta.requiredScopes, [])
  })
})

test('missing required path param is rejected locally (INVALID_ARGS)', async () => {
  await withServer(() => { throw new Error('must not reach the server') }, async (port) => {
    const client = makeClient(port)
    await assert.rejects(
      client.call(endpoint('get_characters_character_id'), {}),
      (error) => error instanceof EsiaError && error.code === 'INVALID_ARGS' && /character_id/.test(error.message),
    )
  })
})

test('assembles query params and enforces required ones', async () => {
  const orders = endpoint('get_markets_region_id_orders')
  assert.ok(orders.queryParams.some((p) => p.name === 'order_type' && p.required))
  await withServer((req, reply) => {
    assert.match(req.url, /^\/markets\/10000002\/orders\/\?/)
    assert.match(req.url, /datasource=serenity/)
    assert.match(req.url, /order_type=buy/)
    assert.match(req.url, /type_id=34/)
    reply.status(200).json([{ order_id: 1 }])
  }, async (port) => {
    const client = makeClient(port)
    const result = await client.call(orders, {
      pathParams: { region_id: 10000002 },
      queryParams: { order_type: 'buy', type_id: 34 },
    })
    assert.equal(result.data.length, 1)
  })
})

test('attaches the bearer token for scoped endpoints and omits it for public ones', async () => {
  await withServer((req, reply) => {
    assert.equal(req.headers.authorization, 'Bearer tok123')
    reply.status(200).json([])
  }, async (port) => {
    const client = makeClient(port, {
      tokenProvider: async (scopes) => {
        assert.deepEqual(scopes, ['esi-assets.read_assets.v1'])
        return 'tok123'
      },
    })
    await client.call(endpoint('get_characters_character_id_assets'), { pathParams: { character_id: 1 } })
  })
  await withServer((req, reply) => {
    assert.equal(req.headers.authorization, undefined)
    reply.status(200).json({})
  }, async (port) => {
    const client = makeClient(port)
    await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
  })
})

test('normalizes 404 into a non-retryable NOT_FOUND EsiaError', async () => {
  await withServer((_req, reply) => {
    reply.status(404).json({ error: 'Character not found' })
  }, async (port) => {
    const client = makeClient(port)
    await assert.rejects(
      client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 999999999 } }),
      (error) => error instanceof EsiaError
        && error.code === 'NOT_FOUND'
        && error.retryable === false
        && /not found/i.test(error.message),
    )
  })
})

test('403 reports the required scopes for the endpoint', async () => {
  await withServer((_req, reply) => {
    reply.status(403).json({ error: 'Forbidden' })
  }, async (port) => {
    const client = makeClient(port, { tokenProvider: async () => undefined })
    await assert.rejects(
      client.call(endpoint('get_characters_character_id_assets'), { pathParams: { character_id: 1 } }),
      (error) => error instanceof EsiaError
        && error.code === 'FORBIDDEN'
        && error.requiredScopes.includes('esi-assets.read_assets.v1'),
    )
  })
})

test('retries 420 rate limiting once then succeeds', async () => {
  let calls = 0
  await withServer((_req, reply) => {
    calls += 1
    if (calls === 1) return reply.status(420).header('Retry-After', '0').json({ error: 'Error limited' })
    reply.status(200).json({ name: 'Recovered' })
  }, async (port) => {
    const client = makeClient(port, { maxRetries: 3 })
    const result = await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
    assert.equal(result.data.name, 'Recovered')
    assert.equal(calls, 2)
  })
})

test('auto-pagination follows X-Pages and concatenates arrays', async () => {
  const seenPages = []
  await withServer((req, reply) => {
    const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1'
    seenPages.push(Number(page))
    reply.status(200).header('X-Pages', '3').json([{ page: Number(page) }])
  }, async (port) => {
    const client = makeClient(port, { maxPages: 10 })
    const result = await client.call(endpoint('get_characters_character_id_assets'), {
      pathParams: { character_id: 1 },
    }, { pages: 'auto' })
    assert.equal(result.data.length, 3)
    assert.equal(result.meta.pages, 3)
    assert.deepEqual(seenPages, [1, 2, 3])
  })
})

test('pages=first returns page 1 only', async () => {
  const seenPages = []
  await withServer((req, reply) => {
    const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1'
    seenPages.push(Number(page))
    reply.status(200).header('X-Pages', '3').json([{ page: Number(page) }])
  }, async (port) => {
    const client = makeClient(port)
    const result = await client.call(endpoint('get_characters_character_id_assets'), {
      pathParams: { character_id: 1 },
    }, { pages: 'first' })
    assert.equal(result.data.length, 1)
    assert.equal(result.meta.pages, 3)
    assert.deepEqual(seenPages, [1])
  })
})

test('ETag caching: second call sends If-None-Match and 304 serves the cached body', async () => {
  const requests = []
  await withServer((req, reply) => {
    requests.push({ url: req.url, ifNoneMatch: req.headers['if-none-match'] })
    if (requests.length === 1) {
      return reply.status(200)
        .header('ETag', '"v1"')
        .header('expires', new Date(Date.now() + 60_000).toUTCString())
        .json({ name: 'Cached' })
    }
    reply.status(304).text()
  }, async (port) => {
    const client = makeClient(port)
    const first = await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
    assert.equal(first.data.name, 'Cached')
    const second = await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
    assert.equal(second.data.name, 'Cached')
    assert.equal(second.meta.cached, true)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].ifNoneMatch, '"v1"')
  })
})

test('expired cache entries skip revalidation and refetch fresh data', async () => {
  const seen = []
  await withServer((req, reply) => {
    seen.push({ ifNoneMatch: req.headers['if-none-match'] })
    reply.status(200).header('ETag', `"v${seen.length}"`).header('expires', new Date(Date.now() - 1000).toUTCString()).json({ n: seen.length })
  }, async (port) => {
    const client = makeClient(port)
    const first = await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
    assert.equal(first.data.n, 1)
    const second = await client.call(endpoint('get_characters_character_id'), { pathParams: { character_id: 1 } })
    assert.equal(second.data.n, 2, 'expired entry must be refetched, not served stale')
    assert.equal(seen[1].ifNoneMatch, undefined, 'expired entry must not send If-None-Match')
  })
})

test('network failure surfaces as retryable NETWORK after retries', async () => {
  const client = new EsiaClient({
    server: 'cn',
    ratePerSecond: 0,
    maxRetries: 2,
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  await assert.rejects(
    client.call(endpoint('get_alliances'), {}),
    (error) => error instanceof EsiaError && error.code === 'NETWORK' && error.retryable === true,
  )
})
