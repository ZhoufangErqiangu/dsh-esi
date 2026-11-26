/**
 * Shared in-process Harness runtime for the tests and offline scripts.
 *
 * DSH 0.2 split tool execution into explicit executor plugins and changed
 * `ToolsService.execute` to take a batch of model calls. This helper mounts the
 * native executor once and wraps the batch protocol in a single-call helper, so
 * tests keep reading like tool calls instead of transport plumbing.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'

/** Mount prompt, tool registry, and the native executor on a fresh root Context. */
export async function setupRuntime() {
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime)
  await root.plugin(NativeExecutor)
  return { root }
}

/**
 * Mint an agent-scoped Context the way the agent loop does: `createScope` is
 * called inside a fiber that resolves the services the scope chain needs.
 * @param {Context} root - runtime root.
 * @param {string} id - agent identity.
 * @returns the structural agent (`{ id, ctx }`) used by tool execution.
 */
export async function createAgent(root, id = 'agent-1') {
  const agent = { id }
  let scope
  await root.plugin(Object.assign(
    (inner) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] },
  ))
  agent.ctx = scope.ctx
  return agent
}

/** One model tool-call block for `ToolsService.execute`. */
export function toolCall(name, args = {}, id = `c-${Math.random().toString(36).slice(2)}`) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
}

/**
 * Execute one tool call through the real pipeline.
 * @param {Context} root - runtime root.
 * @param {{ name: string, args?: object, agent?: object, signal?: AbortSignal }} call - call data.
 * @returns the settled `ToolExecutionResult` (`isError`, `value`, `error`).
 */
export async function runTool(root, { name, args = {}, agent, signal = new AbortController().signal }) {
  const batch = await root.tools.execute({
    calls: [toolCall(name, args)],
    signal,
    ...(agent === undefined ? {} : { agent }),
  })
  return batch.results[0].result
}
