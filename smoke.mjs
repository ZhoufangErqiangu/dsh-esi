/**
 * Runtime smoke test: load the plugin into a real cordis Context with the real
 * dsh-tools / dsh-system-prompt services (resolved via harness symlinks), then
 * exercise the registered esi_status tool end to end.
 * Not part of the committed test suite (needs the harness checkout present).
 */
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply, name } from './src/index.ts'

const ctx = new Context()
new SystemPrompt(ctx, {})
new ToolRuntime(ctx, {})
apply(ctx)

const registry = ctx.tools
if (registry === undefined) throw new Error('ctx.tools missing after ToolRuntime construction')

console.log('plugin name:', name)

// Exercise esi_status end to end through the public registry surface.
const exec = {
  callId: 'smoke-1',
  rootCallId: 'smoke-1',
  name: 'esi_status',
  arguments: {},
  signal: new AbortController().signal,
  token: Symbol('smoke'),
}
const result = await registry.execute(exec)
if (result.isError) throw new Error(`esi_status failed: ${JSON.stringify(result.error)}`)
const value = result.value
console.log('esi_status ok:', value.endpointCount === 204, '| swagger:', value.swaggerVersion, '| authed:', value.authedEndpointCount, '| paginated:', value.paginatedEndpointCount)
console.log('servers:', Object.keys(value.servers).join(','), '| tags:', value.tagCount, '| scopes:', value.scopeCount)

if (value.endpointCount !== 204 || value.authedEndpointCount !== 124) {
  throw new Error('unexpected catalog stats')
}
console.log('SMOKE PASS')
process.exit(0)
