/**
 * SDE update tools: sde_update (user-triggered, dry-run first) and
 * sde_rollback.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SdeUpdater } from '../sde/update.ts'

export function createSdeUpdateTool(updater: SdeUpdater) {
  return defineTool({
    name: 'sde_update',
    description:
      'Update the EVE static data (SDE) from the configured source. ALWAYS call with confirm=false first: this returns '
      + 'a dry-run plan (current build vs latest build, changed tables, estimated download size) without touching '
      + 'anything. Only after the user agrees, call again with confirm=true to download the delta, build the new '
      + 'version directory, and atomically switch the active version. The previous version is kept and can be restored '
      + 'with sde_rollback. This is a user-triggered operation — never run it without the user\'s confirmation.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'false = dry-run plan only; true = execute the update.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      if (args.confirm !== true) {
        return await updater.plan(exec.signal) as unknown as JsonValue
      }
      return await updater.run(exec.signal) as unknown as JsonValue
    },
  })
}

export function createSdeRollbackTool(updater: SdeUpdater) {
  return defineTool({
    name: 'sde_rollback',
    description:
      'Switch the active SDE version back to the previous build (the newest other version on disk). '
      + 'Use when an update introduced bad data. Requires user confirmation via the confirm flag.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true to perform the rollback; false lists versions and returns a no-op.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args): Promise<JsonValue> {
      if (args.confirm !== true) {
        return Promise.resolve({
          dryRun: true,
          versions: updater.listVersions(),
          note: 'call with confirm=true to roll back to the previous build',
        } as unknown as JsonValue)
      }
      return Promise.resolve(updater.rollback() as unknown as JsonValue)
    },
  })
}
