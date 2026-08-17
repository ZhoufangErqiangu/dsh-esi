/**
 * Real-network end-to-end: boots the actual plugin on a real cordis runtime
 * and performs REAL calls against the CN ESI mirror (ali-esi.evepc.163.com)
 * and the local SDE data — the acceptance path for "the plugin loads and
 * completes real calls". Requires outbound HTTPS. Not part of node:test.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply } from '../src/index.ts'

const root = new Context()
await root.plugin(SystemPrompt, {})
await root.plugin(ToolRuntime, { mode: 'native' })

apply(root, { server: 'cn', ratePerSecond: 5, maxPages: 5 })

const exec = (name_, arguments_, agent) => ({
  callId: `e2e-${Math.random().toString(36).slice(2)}`,
  name: name_,
  arguments: arguments_,
  signal: new AbortController().signal,
  ...(agent !== undefined ? { agent } : {}),
})
const ok = (result, label) => {
  if (result.isError) throw new Error(`${label}: ${JSON.stringify(result.error)}`)
  return result.value
}

// 1. status
const status = ok(await root.tools.execute(exec('esi_status', {})), 'esi_status')
console.log('status ok —', status.activeServer.id, status.swaggerVersion, status.endpointCount, 'endpoints')

// 2. search
const search = ok(await root.tools.execute(exec('esi_endpoint_search', { query: 'market orders' })), 'search')
console.log('search ok —', search.matches.slice(0, 3).map((m) => m.operationId).join(', '))

// 3. real public calls
const esiStatus = ok(await root.tools.execute(exec('esi_call', { operation_id: 'get_status' })), 'get_status')
console.log('get_status ok — players', esiStatus.data.players, '| server_version', esiStatus.data.server_version)

const alliances = ok(await root.tools.execute(exec('esi_call', { operation_id: 'get_alliances', pages: 'auto' })), 'get_alliances')
console.log('get_alliances ok —', alliances.data.length, 'alliances, pages', alliances.meta.pages)

const type = ok(await root.tools.execute(exec('esi_call', {
  operation_id: 'get_universe_types_type_id',
  path_params: { type_id: 34 },
  language: 'zh',
})), 'type 34')
console.log('type 34 ok —', type.data.name, '| group', type.data.group_id)

// 4. materialize one endpoint and call it natively
const agent = { id: 'e2e-agent' }
let scope
await root.plugin(Object.assign(
  (inner) => { scope = createScope(inner, agent) },
  { inject: ['tools', 'systemPrompt'] },
))
agent.ctx = scope.ctx
const load = ok(await root.tools.execute(exec('esi_endpoint_load', { operation_ids: ['get_markets_prices'] }, agent)), 'load')
console.log('load ok —', load.loaded[0].name)
const prices = ok(await root.tools.execute(exec('esi_get_markets_prices', {}, agent)), 'get_markets_prices')
console.log('get_markets_prices ok —', prices.data.length, 'prices; sample type', prices.data[0]?.type_id)

// 5. SDE real data
const sde = ok(await root.tools.execute(exec('sde_query', { table: 'types', search_text: 'tritanium', limit: 3 })), 'sde_query')
console.log('sde_query ok —', sde.count, 'matches; first', sde.rows[0]?.name, '| engine', sde.meta.engine)

// 6. hot-path tools: item lookup + market prices (the manufacturing-analysis pair)
const items = ok(await root.tools.execute(exec('esi_item_lookup', {
  type_ids: [25601, 25605, 25590, 30993],
  language: 'zh',
})), 'esi_item_lookup')
console.log('esi_item_lookup ok —', items.rows.map((row) => `${row.type_id}:${row.name}`).join(', '), '| not_found:', items.not_found ?? [])

const market = ok(await root.tools.execute(exec('esi_market_prices', {
  type_ids: [25601, 25605, 25590, 30993],
  language: 'zh',
})), 'esi_market_prices')
for (const row of market.rows) {
  const parts = [`${row.type_id}:${row.name ?? ''}`]
  if (row.average_price !== undefined) parts.push(`avg=${row.average_price.toFixed(2)}`)
  if (row.best_sell_price !== undefined) parts.push(`sell=${row.best_sell_price.toFixed(2)}`)
  if (row.best_buy_price !== undefined) parts.push(`buy=${row.best_buy_price.toFixed(2)}`)
  console.log('  ', parts.join(' | '))
}
console.log('esi_market_prices ok — region', market.meta.region_id, market.meta.region_name ?? '', '| names:', market.meta.names)

console.log('REAL E2E PASS')
process.exit(0)
