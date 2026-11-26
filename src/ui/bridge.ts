/**
 * Browser bridge: one small JSON surface over the Web server's route table,
 * shared by the two settings cards.
 *
 * Why not the settings document? In DSH 0.2 the settings service derives its
 * forms from each plugin entry's `Config`; ad-hoc namespaces are gone, and
 * transient state (download progress, OAuth status) must not be persisted into
 * the user's profile. The cards therefore poll one in-memory state object and
 * POST one action per user gesture, and the very same operations back the
 * `sde_update` / `sde_rollback` tools — no second copy of the pipeline.
 *
 * The bridge is optional: profiles without a Web server (headless, Desktop)
 * simply never mount it, while tools and agent behavior stay unchanged.
 *
 * @module @dsh-esi/plugin-esi
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AccountUi } from '../account/account-state.ts'
import type { SdeUpdateRunner } from '../sde/runner.ts'
import type {
  AccountUiSection,
  BridgeFailure,
  BridgeResponse,
  EsiUiState,
  LoginStatus,
  SdeUiSection,
  SdeUiStatus,
} from './protocol.ts'
import { BRIDGE_ENDPOINTS, BRIDGE_PREFIX } from './protocol.ts'

/** Largest action body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

export interface EsiUiBridgeOptions {
  readonly runner: SdeUpdateRunner
  readonly account: AccountUi
  /** Fallback download URL used when an update request omits one. */
  readonly defaultUpdateUrl?: string
}

/**
 * The bridge. Construct it in `apply`, call {@link attach} to expose the
 * routes, and share {@link runUpdate} / {@link rollback} with the tools.
 */
export class EsiUiBridge {
  private readonly runner: SdeUpdateRunner
  private readonly account: AccountUi
  private readonly defaultUpdateUrl: string | undefined
  private sdeStatus: SdeUiStatus
  private revision = 0
  private exposed = false
  /** Bridge-level guard: a rollback can finish synchronously, so the runner's
   * own flag is already clear when a second request arrives. */
  private updating = false

  constructor(options: EsiUiBridgeOptions) {
    this.runner = options.runner
    this.account = options.account
    this.defaultUpdateUrl = options.defaultUpdateUrl
    this.sdeStatus = options.runner.status()
    this.account.subscribe(() => this.publish())
  }

  /** Whether the HTTP surface is mounted in this composition. */
  get available(): boolean {
    return this.exposed
  }

  /** Mount the routes; a no-op in compositions without a Web server. */
  attach(ctx: Context): void {
    ctx.inject(['webServer'], (webCtx) => {
      this.exposed = true
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'prefix',
          path: BRIDGE_PREFIX,
          handler: (req, res) => { void this.handle(req, res) },
        }),
        'dsh-esi: browser bridge routes',
      )
      webCtx.effect(() => () => { this.exposed = false }, 'dsh-esi: browser bridge availability')
    })
  }

  /** Run one URL update (shared by the card and the `sde_update` tool). */
  async runUpdate(rawUrl: string, signal?: AbortSignal): Promise<SdeUiStatus> {
    if (this.updating) return this.sdeStatus
    const url = rawUrl.trim() === '' ? this.defaultUpdateUrl : rawUrl.trim()
    if (url === undefined || url === '') {
      this.publishSde({
        phase: 'error',
        messageKey: 'err.urlEmpty',
        message: '请输入下载地址',
        error: { code: 'URL_EMPTY', message: '请输入下载地址' },
        currentBuild: this.sdeStatus.currentBuild,
        at: Date.now(),
      })
      return this.sdeStatus
    }
    this.updating = true
    try {
      await this.runner.runUpdate(url, (status) => this.publishSde(status), signal)
    } finally {
      this.updating = false
    }
    return this.sdeStatus
  }

  /** Roll back to the newest other installed build. */
  async rollback(): Promise<SdeUiStatus> {
    if (this.updating) return this.sdeStatus
    this.updating = true
    try {
      await this.runner.rollback((status) => this.publishSde(status))
    } finally {
      this.updating = false
    }
    return this.sdeStatus
  }

  /** Run one browser-driven EVE SSO login. */
  login(): Promise<LoginStatus> {
    return this.account.login()
  }

  /** Revoke one character, or every character when `characterId` is omitted. */
  deauthorize(characterId?: number): string[] {
    return this.account.deauthorize(characterId)
  }

  /** Select the default market region, or clear it with `undefined`. */
  setRegion(regionId: number | undefined): boolean {
    return this.account.setRegion(regionId)
  }

  /** The complete state the cards poll. */
  snapshot(): EsiUiState {
    const sde: SdeUiSection = {
      available: this.exposed,
      status: this.sdeStatus,
      versions: this.runner.listVersions(),
      ...(this.defaultUpdateUrl === undefined ? {} : { defaultUpdateUrl: this.defaultUpdateUrl }),
    }
    const account: AccountUiSection = {
      available: this.exposed,
      characters: this.account.characters(),
      regions: this.account.regions(),
      defaultRegionId: this.account.defaultRegionId(),
      status: this.account.status(),
    }
    return { revision: this.revision, sde, account }
  }

  // ---- HTTP -----------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = bridgePath(req.url)
      if (path === undefined) {
        fail(res, 404, 'NOT_FOUND', `unknown bridge path ${req.url ?? ''}`)
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path !== BRIDGE_ENDPOINTS.state) {
          fail(res, 404, 'NOT_FOUND', `unknown bridge path ${path}`)
          return
        }
        reply(res, 200, this.snapshot(), req.method === 'HEAD')
        return
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, HEAD, POST')
        fail(res, 405, 'METHOD_NOT_ALLOWED', `method ${req.method ?? '?'} is not allowed`)
        return
      }
      if (isCrossOrigin(req)) {
        fail(res, 403, 'CROSS_ORIGIN', 'cross-origin writes are refused')
        return
      }
      // Drain the body for every POST so keep-alive connections stay usable;
      // actions that carry no fields accept the empty body.
      const body = await readJsonBody(req)
      if (path === BRIDGE_ENDPOINTS.sdeUpdate) {
        const url = typeof body?.url === 'string' ? body.url : ''
        void this.runUpdate(url)
        reply(res, 202, this.snapshot())
        return
      }
      if (path === BRIDGE_ENDPOINTS.sdeRollback) {
        void this.rollback()
        reply(res, 202, this.snapshot())
        return
      }
      if (path === BRIDGE_ENDPOINTS.login) {
        void this.login()
        reply(res, 202, this.snapshot())
        return
      }
      if (path === BRIDGE_ENDPOINTS.deauthorize) {
        const raw = body?.characterId
        if (raw !== undefined && raw !== null && integerField(raw) === undefined) {
          fail(res, 400, 'CHARACTER_INVALID', 'characterId must be an integer')
          return
        }
        this.deauthorize(integerField(raw))
        reply(res, 200, this.snapshot())
        return
      }
      if (path === BRIDGE_ENDPOINTS.region) {
        const raw = body?.regionId
        // `null` clears the selection so market tools fall back to Jita.
        const regionId = raw === null ? undefined : integerField(raw)
        if (raw !== null && regionId === undefined) {
          fail(res, 400, 'REGION_INVALID', 'regionId must be an integer or null')
          return
        }
        if (!this.setRegion(regionId)) {
          fail(res, 400, 'REGION_UNKNOWN', `unknown market region ${String(raw)}`)
          return
        }
        reply(res, 200, this.snapshot())
        return
      }
      fail(res, 404, 'NOT_FOUND', `unknown bridge path ${path}`)
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        fail(res, error.status, error.code, error.message)
        return
      }
      fail(res, 500, 'INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }

  private publishSde(status: SdeUiStatus): void {
    this.sdeStatus = status
    this.publish()
  }

  private publish(): void {
    this.revision += 1
  }
}

// ---- HTTP helpers -----------------------------------------------------------

class BridgeHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Match an absolute bridge path; undefined when the request is outside it. */
function bridgePath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const queryAt = raw.indexOf('?')
  const path = queryAt >= 0 ? raw.slice(0, queryAt) : raw
  if (path !== BRIDGE_PREFIX && !path.startsWith(`${BRIDGE_PREFIX}/`)) return undefined
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** Refuse a browser page on another origin; same-origin and non-browser posts pass. */
function isCrossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new BridgeHttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BridgeHttpError(400, 'BAD_JSON', 'request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BridgeHttpError(400, 'BAD_BODY', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function integerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function reply(res: ServerResponse, status: number, state: EsiUiState, headOnly = false): void {
  const body: BridgeResponse = { ok: true, state }
  writeJson(res, status, body, headOnly)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) return
  const body: BridgeFailure = { ok: false, status, error: { code, message } }
  writeJson(res, status, body)
}

function writeJson(res: ServerResponse, status: number, body: BridgeResponse | BridgeFailure, headOnly = false): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(headOnly ? undefined : text)
}
