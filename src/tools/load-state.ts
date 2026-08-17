/**
 * Bookkeeping for on-demand materialized endpoint tools.
 *
 * Materialized tools are registered per agent via `agent.ctx.tools.register()`
 * (scoped layer; auto-unregisters when the agent context disposes). This module
 * tracks the per-agent set so `esi_endpoint_load` can enforce the cap, list
 * loaded tools, and unload specific ones.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Structural agent view; satisfies `ToolExecution.agent` at runtime. */
export interface EsiaAgentLike {
  readonly id: string
  readonly ctx: Context
}

export interface LoadedToolInfo {
  readonly name: string
  readonly operationId: string
}

interface LoadedEntry {
  readonly operationId: string
  dispose(): void
}

const loadedByAgent = new WeakMap<object, Map<string, LoadedEntry>>()

/** Native tool name for one operationId: `esi_<operationId>`. */
export function materializedToolName(operationId: string): string {
  return `esi_${operationId}`
}

function entriesFor(agent: EsiaAgentLike): Map<string, LoadedEntry> {
  let entries = loadedByAgent.get(agent)
  if (entries === undefined) {
    entries = new Map()
    loadedByAgent.set(agent, entries)
  }
  return entries
}

export function isLoaded(agent: EsiaAgentLike, operationId: string): boolean {
  return entriesFor(agent).has(materializedToolName(operationId))
}

export function loadedCount(agent: EsiaAgentLike): number {
  return entriesFor(agent).size
}

export function listLoaded(agent: EsiaAgentLike): LoadedToolInfo[] {
  return [...entriesFor(agent).entries()].map(([name, entry]) => ({ name, operationId: entry.operationId }))
}

export function recordLoaded(agent: EsiaAgentLike, operationId: string, dispose: () => void): void {
  const entries = entriesFor(agent)
  const name = materializedToolName(operationId)
  entries.set(name, { operationId, dispose })
  // Drop the bookkeeping entry when the agent context (and with it the scoped
  // tool registration) is disposed.
  agent.ctx.effect(() => () => {
    entries.delete(name)
  }, `dsh-esi: bookkeeping ${name}`)
}

export function dropLoaded(agent: EsiaAgentLike, operationId: string): boolean {
  const entries = entriesFor(agent)
  const name = materializedToolName(operationId)
  const entry = entries.get(name)
  if (entry === undefined) return false
  entries.delete(name)
  entry.dispose()
  return true
}
