#!/usr/bin/env node
/**
 * Generate `src/generated/catalog.ts` from `public/json/esi.json`.
 *
 * The catalog is the compact, model-facing index of all ESI endpoints that the
 * plugin's tool surface reads (search / dispatcher / on-demand materialization).
 * Nothing here is hand-written per endpoint: the swagger file is the only
 * source of truth, so an ESI spec refresh is a one-command regeneration.
 *
 * Usage:
 *   node scripts/gen-catalog.mjs            # write src/generated/catalog.ts
 *   node scripts/gen-catalog.mjs --check    # verify the committed file is up to date (exit 1 on drift)
 *
 * Pure Node ESM, no dependencies. Also importable for tests.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_PATH = join(ROOT, 'public', 'json', 'esi.json')
const OUT_PATH = join(ROOT, 'src', 'generated', 'catalog.ts')

/**
 * Parameters the dispatcher manages itself and therefore must NOT be offered
 * to the model as endpoint arguments:
 *  - datasource       server-selected (cn/global profile)
 *  - token            the dispatcher attaches the Authorization header
 *  - If-None-Match    cache validator, handled by the dispatcher cache layer
 *  - Accept-Language  request-localization, handled by the dispatcher
 */
const DISPATCHER_MANAGED_PARAMS = new Set(['datasource', 'token', 'If-None-Match', 'Accept-Language'])

/** ESI server profiles; both mirrors are always available, switchable at runtime. */
const SERVERS = {
  cn: {
    id: 'cn',
    label: '国服 Serenity',
    esiBase: 'https://ali-esi.evepc.163.com',
    loginBase: 'https://login.evepc.163.com',
    datasource: 'serenity',
    datasourceOptions: ['serenity', 'infinity'],
    languageOptions: ['en', 'en-us', 'zh'],
  },
  global: {
    id: 'global',
    label: '世界服 Tranquility',
    esiBase: 'https://esi.evetech.net',
    loginBase: 'https://login.eveonline.com',
    datasource: 'tranquility',
    datasourceOptions: ['tranquility'],
    languageOptions: ['en', 'en-us'],
  },
}

function collapseWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function clip(text, max) {
  const collapsed = collapseWhitespace(text)
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}…`
}

function tsString(value) {
  return JSON.stringify(value)
}

/** Build the in-memory catalog for one swagger spec (pure). */
export function buildCatalog(spec) {
  const globalParams = spec.parameters ?? {}
  const paths = spec.paths ?? {}
  const methods = new Set(['get', 'post', 'put', 'delete'])
  const endpoints = []

  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!methods.has(method)) continue

      const rawParams = op.parameters ?? []
      const params = []
      for (const raw of rawParams) {
        let p = raw
        if (raw.$ref) {
          const name = String(raw.$ref).replace(/^#\/parameters\//, '')
          p = globalParams[name]
          if (p === undefined) {
            throw new Error(`unresolved parameter $ref ${raw.$ref} on ${method.toUpperCase()} ${path}`)
          }
        }
        params.push(p)
      }

      const scopes = []
      for (const sec of op.security ?? []) {
        for (const [scheme, scopeList] of Object.entries(sec)) {
          if (scheme === 'evesso') scopes.push(...(scopeList ?? []))
        }
      }

      const pathParams = []
      const queryParams = []
      let body
      for (const p of params) {
        if (p.name === undefined || p.in === undefined) continue
        if (DISPATCHER_MANAGED_PARAMS.has(p.name)) continue
        const param = {
          name: p.name,
          required: p.required === true,
          type: ['integer', 'number', 'boolean', 'array'].includes(p.type) ? p.type : 'string',
          ...(Array.isArray(p.enum) ? { enum: p.enum } : {}),
          description: clip(p.description, 100),
        }
        if (p.in === 'path') pathParams.push(param)
        else if (p.in === 'query') queryParams.push(param)
        else if (p.in === 'body') {
          body = {
            required: p.required === true,
            description: clip(p.description, 200),
            schema: p.schema ?? null,
          }
        }
      }

      endpoints.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        tags: [...(op.tags ?? [])],
        summary: clip(op.summary ?? '', 200),
        scopes: [...new Set(scopes)].sort(),
        pathParams,
        queryParams,
        ...(body !== undefined ? { body } : {}),
        paginated: queryParams.some((q) => q.name === 'page'),
      })
    }
  }

  endpoints.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0))

  const tagCounts = new Map()
  for (const ep of endpoints) {
    for (const tag of ep.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const scopes = Object.entries(spec.securityDefinitions?.evesso?.scopes ?? {})
    .map(([scope, description]) => ({ scope, description: String(description) }))
    .sort((a, b) => (a.scope < b.scope ? -1 : 1))

  const endpointIndex = {}
  endpoints.forEach((ep, index) => { endpointIndex[ep.operationId] = index })

  return {
    swaggerVersion: spec.info?.version ?? '',
    servers: SERVERS,
    endpoints,
    endpointIndex,
    tags,
    scopes,
  }
}

function renderParam(p) {
  const parts = [
    `name: ${tsString(p.name)}`,
    `required: ${p.required}`,
    `type: ${tsString(p.type)}`,
  ]
  if (p.enum !== undefined) parts.push(`enum: ${tsString(p.enum)}`)
  if (p.description !== '') parts.push(`description: ${tsString(p.description)}`)
  return `{ ${parts.join(', ')} }`
}

function renderEndpoint(ep) {
  const parts = [
    `operationId: ${tsString(ep.operationId)}`,
    `method: ${tsString(ep.method)}`,
    `path: ${tsString(ep.path)}`,
    `tags: ${tsString(ep.tags)}`,
    `summary: ${tsString(ep.summary)}`,
    `scopes: ${tsString(ep.scopes)}`,
    `pathParams: [${ep.pathParams.map(renderParam).join(', ')}]`,
    `queryParams: [${ep.queryParams.map(renderParam).join(', ')}]`,
  ]
  if (ep.body !== undefined) {
    parts.push(
      `body: { required: ${ep.body.required}, description: ${tsString(ep.body.description)}, schema: ${JSON.stringify(ep.body.schema)} }`,
    )
  }
  parts.push(`paginated: ${ep.paginated}`)
  return `{ ${parts.join(', ')} }`
}

/** Render the catalog as a TypeScript source string (pure, deterministic). */
export function renderCatalog(spec) {
  const catalog = buildCatalog(spec)
  const sha = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
  const lines = []
  lines.push('// @generated by scripts/gen-catalog.mjs from public/json/esi.json — DO NOT EDIT.')
  lines.push('// Regenerate with `pnpm run gen`; `pnpm run gen:check` verifies this file is current.')
  lines.push(`// Input sha256: ${sha}`)
  lines.push('import type { CatalogBody, CatalogEndpoint, CatalogParam, CatalogScope, CatalogServer, CatalogTag } from \'../catalog-types.js\'')
  lines.push('')
  lines.push(`export const SWAGGER_VERSION = ${tsString(catalog.swaggerVersion)}`)
  lines.push('')
  lines.push('export const SERVERS: Record<string, CatalogServer> = {')
  for (const [id, server] of Object.entries(catalog.servers)) {
    lines.push(`  ${id}: { id: ${tsString(server.id)}, label: ${tsString(server.label)}, esiBase: ${tsString(server.esiBase)}, loginBase: ${tsString(server.loginBase)}, datasource: ${tsString(server.datasource)}, datasourceOptions: ${tsString(server.datasourceOptions)}, languageOptions: ${tsString(server.languageOptions)} },`)
  }
  lines.push('}')
  lines.push('')
  lines.push('export const ENDPOINTS: readonly CatalogEndpoint[] = [')
  for (const ep of catalog.endpoints) lines.push(`  ${renderEndpoint(ep)},`)
  lines.push(']')
  lines.push('')
  lines.push('export const ENDPOINT_INDEX: Readonly<Record<string, number>> = {')
  for (const [operationId, index] of Object.entries(catalog.endpointIndex)) {
    lines.push(`  ${tsString(operationId)}: ${index},`)
  }
  lines.push('}')
  lines.push('')
  lines.push('export const TAGS: readonly CatalogTag[] = [')
  for (const tag of catalog.tags) lines.push(`  { name: ${tsString(tag.name)}, count: ${tag.count} },`)
  lines.push(']')
  lines.push('')
  lines.push('export const SCOPES: readonly CatalogScope[] = [')
  for (const scope of catalog.scopes) lines.push(`  { scope: ${tsString(scope.scope)}, description: ${tsString(scope.description)} },`)
  lines.push(']')
  lines.push('')
  lines.push('export type { CatalogBody, CatalogEndpoint, CatalogParam, CatalogScope, CatalogServer, CatalogTag }')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'))
  const rendered = renderCatalog(spec)
  if (check) {
    const current = readFileSync(OUT_PATH, 'utf8')
    if (current !== rendered) {
      console.error(`gen-catalog: ${OUT_PATH} is out of date — run \`pnpm run gen\``)
      process.exit(1)
    }
    console.log(`gen-catalog: ${OUT_PATH} is up to date`)
    process.exit(0)
  }
  writeFileSync(OUT_PATH, rendered)
  const count = buildCatalog(spec).endpoints.length
  console.log(`gen-catalog: wrote ${OUT_PATH} (${count} endpoints)`)
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
