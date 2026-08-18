/**
 * Cordis bridge for the GUI-driven SDE update: registers the `dsh-esi`
 * settings namespace the settings card binds, watches trigger fields
 * (`sdeUpdateRequest` / `sdeRollbackRequest`), runs the update pipeline, and
 * mirrors progress/errors back through `sdeUpdateStatus`.
 *
 * The settings document doubles as the wire channel here (deliberately: the
 * browser cannot call host RPCs this plugin may add, and the platform already
 * forwards `settings/*` events to the browser). The trigger fields are
 * one-shot — a new `nonce` arms a new run; status writes never re-arm it.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SdeGuiRunner, type SdeGuiStatus } from './gui-runner.ts'
import type { SdeLanguage } from './types.ts'

export interface SdeGuiBridgeOptions {
  readonly dataRoot: string
  readonly defaultLanguage?: SdeLanguage
}

/** The namespace the settings card binds. */
export const SDE_GUI_NAMESPACE = 'dsh-esi'

/** Wire shape of the namespace section. */
export interface SdeGuiSettings {
  readonly sdeUpdateUrl?: string
  readonly sdeUpdateRequest?: { readonly url: string; readonly nonce: number }
  readonly sdeRollbackRequest?: { readonly nonce: number }
  readonly sdeUpdateStatus?: SdeGuiStatus
}

/** Schemastery schema registered for the namespace (validates client writes and statuses alike). */
export const SdeGuiSettingsSchema = z.object({
  sdeUpdateUrl: z.string().required(false),
  sdeUpdateRequest: z.object({
    url: z.string(),
    nonce: z.number(),
  }).required(false),
  sdeRollbackRequest: z.object({
    nonce: z.number(),
  }).required(false),
  sdeUpdateStatus: z.object({
    phase: z.string(),
    message: z.string(),
    progress: z.number().required(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }).required(false),
    currentBuild: z.number().required(false),
    previousBuild: z.number().required(false),
    at: z.number(),
  }).required(false),
})

/**
 * Mount the GUI bridge. Uses dynamic injection so the plugin keeps working in
 * headless profiles that have no settings service.
 * @returns the shared SdeGuiRunner (also used by the sde_update url tool).
 */
export function attachSdeGui(ctx: Context, options: SdeGuiBridgeOptions): SdeGuiRunner {
  const runner = new SdeGuiRunner(options)
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace(SDE_GUI_NAMESPACE),
      SdeGuiSettingsSchema,
    )
    const publish = (status: SdeGuiStatus): void => {
      // replace() (not update()): update deep-merges, so a status written
      // after the download phase would keep the stale `progress` field from
      // the downloading status. replace() swaps the whole user section.
      void scope.replace({ sdeUpdateStatus: status }).catch((error) => {
        settingsCtx.logger.warn(`dsh-esi: failed to publish SDE status: ${String(error)}`)
      })
    }

    // Publish the idle snapshot so the card renders the current build without
    // requiring a user action first.
    publish(runner.status())

    let lastUpdateNonce = 0
    let lastRollbackNonce = 0
    settingsCtx.effect(() => {
      // Watcher invocations are serialized by the settings service (one at a
      // time, in commit order), so an update and a rollback never interleave.
      // The trigger fields resolve to `{}` (schema default) when absent, so
      // only a numeric nonce arms a run — a bare default never does.
      const disposer = scope.watch(async (next) => {
        const request = next.sdeUpdateRequest
        if (typeof request?.nonce === 'number' && request.nonce !== lastUpdateNonce) {
          lastUpdateNonce = request.nonce
          await runner.runUpdate(request.url, publish)
        }
        const rollback = next.sdeRollbackRequest
        if (typeof rollback?.nonce === 'number' && rollback.nonce !== lastRollbackNonce) {
          lastRollbackNonce = rollback.nonce
          await runner.rollback(publish)
        }
      })
      return disposer
    }, 'dsh-esi: sde gui watcher')
  })
  return runner
}
