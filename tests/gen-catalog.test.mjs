/**
 * Tests for the ESI endpoint catalog generator.
 *
 * Invariants are hard-coded so a swagger refresh that changes the API surface
 * FAILS loudly here — regenerating the catalog is a conscious, reviewed step.
 * Run with `node --test tests/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCatalog, renderCatalog } from '../scripts/gen-catalog.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = JSON.parse(readFileSync(join(ROOT, 'public', 'json', 'esi.json'), 'utf8'))
const OUT_PATH = join(ROOT, 'src', 'generated', 'catalog.ts')
const OUT = readFileSync(OUT_PATH, 'utf8')

// ---- hard-coded API surface baseline (review deliberately when ESI changes) ----
const BASELINE = {
  operations: 204,
  get: 170,
  post: 20,
  put: 7,
  delete: 7,
  authedOperations: 124,
  paginatedOperations: 44,
  bodyOperations: 21,
  tags: 32,
  paths: 189,
}

function collectPaths(spec) {
  const paths = spec.paths ?? {}
  const seen = new Set()
  const ops = []
  for (const [path, item] of Object.entries(paths)) {
    seen.add(path)
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue
      ops.push({ path, method, op })
    }
  }
  return { paths: seen, ops }
}

function resolveParams(spec, op) {
  const globalParams = spec.parameters ?? {}
  const resolved = []
  for (const raw of op.parameters ?? []) {
    if (raw.$ref) {
      const name = String(raw.$ref).replace(/^#\/parameters\//, '')
      resolved.push(globalParams[name])
    } else {
      resolved.push(raw)
    }
  }
  return resolved
}

test('spec surface matches the hard-coded baseline (review on ESI updates)', () => {
  const { paths, ops } = collectPaths(SPEC)
  assert.equal(paths.size, BASELINE.paths)
  assert.equal(ops.length, BASELINE.operations)
  const byMethod = Object.groupBy(ops, (o) => o.method)
  assert.equal(byMethod.get?.length, BASELINE.get)
  assert.equal(byMethod.post?.length, BASELINE.post)
  assert.equal(byMethod.put?.length, BASELINE.put)
  assert.equal(byMethod.delete?.length, BASELINE.delete)
  const authed = ops.filter((o) => o.op.security !== undefined && o.op.security.length > 0).length
  assert.equal(authed, BASELINE.authedOperations)
  const paginated = ops.filter((o) => resolveParams(SPEC, o.op).some((p) => p?.name === 'page')).length
  assert.equal(paginated, BASELINE.paginatedOperations)
  const body = ops.filter((o) => resolveParams(SPEC, o.op).some((p) => p?.in === 'body')).length
  assert.equal(body, BASELINE.bodyOperations)
  const tags = new Set(ops.flatMap((o) => o.op.tags ?? []))
  assert.equal(tags.size, BASELINE.tags)
})

test('catalog covers every operation exactly once with unique operationIds', () => {
  const catalog = buildCatalog(SPEC)
  assert.equal(catalog.endpoints.length, BASELINE.operations)
  const ids = catalog.endpoints.map((e) => e.operationId)
  assert.equal(new Set(ids).size, ids.length, 'operationIds must be unique')
  const { ops } = collectPaths(SPEC)
  const specIds = new Set(ops.map((o) => o.op.operationId))
  assert.equal(specIds.size, BASELINE.operations)
  for (const id of specIds) assert.ok(ids.includes(id), `missing endpoint ${id}`)
})

test('every swagger $ref resolves (no unresolved or leaked $ref in catalog)', () => {
  const rendered = renderCatalog(SPEC)
  assert.ok(!rendered.includes('$ref'), 'generated catalog must not contain raw $refs')
  // Building with a spec that contains an unresolvable ref must throw.
  const broken = structuredClone(SPEC)
  broken.paths['/alliances/'].get.parameters = [{ $ref: '#/parameters/does-not-exist' }]
  assert.throws(() => buildCatalog(broken), /unresolved parameter/)
})

test('every path template variable has a matching path parameter', () => {
  const catalog = buildCatalog(SPEC)
  for (const endpoint of catalog.endpoints) {
    const vars = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
    const names = new Set(endpoint.pathParams.map((p) => p.name))
    for (const v of vars) {
      assert.ok(names.has(v), `${endpoint.operationId}: path var {${v}} missing pathParam`)
    }
    for (const p of endpoint.pathParams) {
      assert.ok(p.required, `${endpoint.operationId}: path param ${p.name} must be required`)
    }
  }
})

test('dispatcher-managed parameters are excluded from the catalog', () => {
  const catalog = buildCatalog(SPEC)
  const managed = new Set(['datasource', 'token', 'If-None-Match', 'Accept-Language'])
  for (const endpoint of catalog.endpoints) {
    for (const p of [...endpoint.pathParams, ...endpoint.queryParams]) {
      assert.ok(!managed.has(p.name), `${endpoint.operationId}: managed param ${p.name} leaked`)
    }
  }
})

test('auth scopes are extracted and consistent', () => {
  const catalog = buildCatalog(SPEC)
  const authed = catalog.endpoints.filter((e) => e.scopes.length > 0)
  assert.equal(authed.length, BASELINE.authedOperations)
  for (const endpoint of authed) {
    for (const scope of endpoint.scopes) {
      assert.match(scope, /^esi-[a-z0-9_.-]+$/, `${endpoint.operationId}: bad scope ${scope}`)
    }
  }
  const scopeNames = new Set(catalog.scopes.map((s) => s.scope))
  for (const endpoint of authed) {
    for (const scope of endpoint.scopes) assert.ok(scopeNames.has(scope), `scope ${scope} missing from scope table`)
  }
  assert.ok(catalog.scopes.length >= 50, 'expected a substantial scope table')
})

test('pagination and body flags match the spec', () => {
  const catalog = buildCatalog(SPEC)
  assert.equal(catalog.endpoints.filter((e) => e.paginated).length, BASELINE.paginatedOperations)
  assert.equal(catalog.endpoints.filter((e) => e.body !== undefined).length, BASELINE.bodyOperations)
})

test('servers profile covers both mirrors with correct datasource values', () => {
  const catalog = buildCatalog(SPEC)
  assert.deepEqual(Object.keys(catalog.servers).sort(), ['cn', 'global'])
  assert.equal(catalog.servers.cn.datasource, 'serenity')
  assert.deepEqual(catalog.servers.cn.datasourceOptions, ['serenity', 'infinity'])
  assert.equal(catalog.servers.global.datasource, 'tranquility')
  assert.match(catalog.servers.cn.esiBase, /^https:\/\//)
  assert.match(catalog.servers.global.esiBase, /^https:\/\//)
})

test('rendering is deterministic', () => {
  const a = renderCatalog(SPEC)
  const b = renderCatalog(SPEC)
  assert.equal(a, b)
})

test('committed generated catalog is current (run `pnpm run gen` on drift)', () => {
  const rendered = renderCatalog(SPEC)
  assert.equal(OUT, rendered, 'src/generated/catalog.ts is out of date — run `pnpm run gen`')
})

test('committed catalog contains the full endpoint set with index consistency', () => {
  const catalog = buildCatalog(SPEC)
  const ids = catalog.endpoints.map((e) => e.operationId)
  for (const id of ids) {
    assert.ok(OUT.includes(`operationId: ${JSON.stringify(id)}`), `generated file missing ${id}`)
    assert.ok(OUT.includes(`${JSON.stringify(id)}: ${catalog.endpointIndex[id]}`), `index missing ${id}`)
  }
  assert.equal(Object.keys(catalog.endpointIndex).length, ids.length)
})
