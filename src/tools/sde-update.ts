/**
 * SDE update tools: sde_update (user-triggered, dry-run first) and
 * sde_rollback. sde_update runs either against the configured source or, with
 * a `url` argument, against an arbitrary download URL (a zip mirror — see
 * ZipSdeSource). All URL-path failures surface as typed, user-readable
 * errors; the previous version is always kept for rollback.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { EsiaAbortSignal } from '../esia-client.ts'
import type { SdeUpdater } from '../sde/update.ts'
import { SdeZipError, ZipSdeSource, validateSdeUrl } from '../sde/zip-source.ts'

/** Executes one URL-driven update and resolves with the final status. */
export type UrlUpdateRunner = (url: string, signal: EsiaAbortSignal | undefined) => Promise<unknown>

export function createSdeUpdateTool(updater: SdeUpdater | undefined, urlRunner?: UrlUpdateRunner) {
  return defineTool({
    name: 'sde_update',
    description:
      'Update the EVE static data (SDE). Two modes: (1) from the configured source (no url), or (2) from a download URL '
      + 'pointing at a zip containing manifest.json plus one .jsonl per table (a jsonl mirror). ALWAYS call with '
      + 'confirm=false first: this returns a dry-run plan without touching anything. Only after the user agrees, call '
      + 'again with confirm=true to download, build the new version directory, and atomically switch the active '
      + 'version. The previous version is kept and can be restored with sde_rollback. This is a user-triggered '
      + 'operation — never run it without the user\'s confirmation.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'false = dry-run plan only; true = execute the update.' },
      url: {
        type: 'string',
        description: 'http(s) download URL of the SDE mirror zip. Omit to use the configured source. '
          + 'The URL is validated (http/https only), reachability is probed, and network/archive errors are reported.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const url: unknown = args.url
      if (url !== undefined) {
        if (typeof url !== 'string') {
          return { dryRun: false, ok: false, error: { code: 'URL_INVALID', message: 'url 必须是字符串' } } as unknown as JsonValue
        }
        if (urlRunner === undefined) {
          return {
            dryRun: false,
            ok: false,
            error: { code: 'NO_URL_RUNNER', message: 'URL 更新功能不可用（插件未启用该路径）' },
          } as unknown as JsonValue
        }
        if (args.confirm !== true) {
          return await planFromUrl(url, exec.signal) as unknown as JsonValue
        }
        const result = await urlRunner(url, exec.signal)
        return result as JsonValue
      }
      if (updater === undefined) {
        return {
          dryRun: false,
          ok: false,
          error: { code: 'NO_SOURCE', message: '未配置 SDE 更新源；请传入 url 参数或配置 sdeUpdateSource' },
        } as unknown as JsonValue
      }
      if (args.confirm !== true) {
        return await updater.plan(exec.signal) as unknown as JsonValue
      }
      return await updater.run(exec.signal) as unknown as JsonValue
    },
  })
}

export function createSdeRollbackTool(updater: SdeUpdater | undefined) {
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
      if (updater === undefined) {
        return Promise.resolve({
          dryRun: true,
          error: 'SDE 回滚不可用：更新管线未初始化',
        } as unknown as JsonValue)
      }
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

/** Dry-run for a URL: validate the address and probe reachability/size (no download). */
async function planFromUrl(url: string, signal?: EsiaAbortSignal): Promise<Record<string, unknown>> {
  let source: ZipSdeSource
  try {
    source = new ZipSdeSource(url)
  } catch (error) {
    return urlError(error)
  }
  try {
    const probe = await source.probe(signal)
    return {
      dryRun: true,
      mode: 'url',
      url: source.url.href,
      reachable: true,
      buildNumber: probe.buildNumber ?? null,
      estimatedBytes: probe.estimatedBytes ?? null,
      note: 'call with confirm=true to download and install this build',
    }
  } catch (error) {
    return urlError(error)
  }
}

function urlError(error: unknown): Record<string, unknown> {
  if (error instanceof SdeZipError) {
    return { dryRun: true, ok: false, error: { code: error.code, message: error.message } }
  }
  return { dryRun: true, ok: false, error: { code: 'INTERNAL', message: String(error) } }
}

/** validateSdeUrl is re-exported for callers that want the same rule set. */
export { validateSdeUrl }
