/**
 * ESI HTTP client layer — everything the model should never have to think
 * about: URL construction, OAuth token attachment, rate limiting, retry with
 * backoff, X-Pages pagination, ETag caching, and error normalization.
 *
 * Consumed by the `esi_call` dispatcher and by materialized endpoint tools.
 * Network access is injected (`fetchImpl`) so tests run against a mock server
 * and the real client stays dependency-free (Node 18+ global fetch).
 */

import type { CatalogEndpoint, ServerId } from './catalog-types.ts'
import { SERVERS } from './generated/catalog.ts'

export type { ServerId } from './catalog-types.ts'

/** Minimal structural types so this module typechecks without DOM/node libs. */
export interface EsiaAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
}

export interface EsiaHeaders {
  get(name: string): string | null
}

export interface EsiaFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: EsiaAbortSignal
}

export interface EsiaResponseLike {
  readonly status: number
  readonly headers: EsiaHeaders
  text(): Promise<string>
}

export type EsiaFetch = (
  input: string,
  init?: EsiaFetchInit,
) => Promise<EsiaResponseLike>

export interface EsiaClientConfig {
  server: ServerId
  /**
   * Resolve a bearer token covering the given scopes, or `undefined` when the
   * user has not authorized them. OAuth flow arrives in a later phase.
   */
  tokenProvider?: (scopes: readonly string[]) => Promise<string | undefined>
  /** Requests per second pacing (token-bucket style); 0 disables. */
  ratePerSecond?: number
  /** Cap on auto-paginated pages; 0 disables auto-pagination. */
  maxPages?: number
  /** Max retries on retryable failures (420/520/5xx/network). */
  maxRetries?: number
  fetchImpl?: EsiaFetch
}

export interface EsiaCallOptions {
  /** 'first' returns page 1 only; 'auto' follows X-Pages up to maxPages. */
  pages?: 'first' | 'auto'
  /** Localization selector for responses (e.g. 'zh', 'en-us'). */
  language?: string
  signal?: EsiaAbortSignal
}

export interface EsiaResultMeta {
  readonly status: number
  readonly cached: boolean
  readonly page: number
  /** Total pages per X-Pages, when the response exposed it. */
  readonly pages?: number
  readonly expires?: string
  readonly retryCount: number
  /** Scopes this endpoint requires (for the model to know what to authorize). */
  readonly requiredScopes: readonly string[]
  readonly url: string
}

export interface EsiaResult {
  readonly data: unknown
  readonly meta: EsiaResultMeta
}

export type EsiaErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'INVALID_ARGS'
  | 'HTTP'

export class EsiaError extends Error {
  readonly status: number
  readonly code: EsiaErrorCode
  readonly retryable: boolean
  readonly requiredScopes: readonly string[]

  constructor(message: string, opts: {
    status?: number
    code: EsiaErrorCode
    retryable?: boolean
    requiredScopes?: readonly string[]
  }) {
    super(message)
    this.name = 'EsiaError'
    this.status = opts.status ?? 0
    this.code = opts.code
    this.retryable = opts.retryable ?? false
    this.requiredScopes = opts.requiredScopes ?? []
  }
}

/** One cached response: validator, expiry, and the body as parsed JSON. */
interface CacheEntry {
  etag: string | null
  expiresAt: number
  data: unknown
}

const DEFAULT_USER_AGENT = 'dsh-esi/0.1 (EVE Online DSH plugin)'
const DEFAULT_MAX_PAGES = 50
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RATE_PER_SECOND = 15

interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body?: string
}

export class EsiaClient {
  readonly serverId: ServerId
  private readonly config: EsiaClientConfig
  private readonly fetchImpl: EsiaFetch
  private readonly cache = new Map<string, CacheEntry>()
  // Next wall-clock ms at which a request may start (pacing).
  private nextAllowedAt = 0

  constructor(config: EsiaClientConfig) {
    this.serverId = config.server
    this.config = config
    const nativeFetch = globalThis.fetch
    this.fetchImpl = config.fetchImpl
      ?? ((input: string, init?: EsiaFetchInit) =>
        nativeFetch(input, init as RequestInit) as unknown as Promise<EsiaResponseLike>)
  }

  get serverProfile() {
    const server = SERVERS[this.serverId]
    if (server === undefined) {
      throw new Error(`unknown ESI server id "${this.serverId}"`)
    }
    return server
  }

  /**
   * Perform one endpoint call, returning normalized data + metadata.
   * @throws EsiaError with a normalized code on any failure.
   */
  async call(endpoint: CatalogEndpoint, args: {
    pathParams?: Record<string, unknown>
    queryParams?: Record<string, unknown>
    body?: unknown
  }, options: EsiaCallOptions = {}): Promise<EsiaResult> {
    const request = await this.buildRequest(endpoint, args, options)
    const cacheKey = request.url
    const cached = this.cache.get(cacheKey)
    const headers: Record<string, string> = { ...request.headers }
    if (cached !== undefined && !this.isExpired(cached)) {
      headers['If-None-Match'] = cached.etag ?? ''
    }

    let response = await this.fetchWithRetry(request.url, headers, request.body, options.signal)
    if (response.status === 304 && cached !== undefined) {
      return { data: cached.data, meta: this.meta(response, true, request.url, 1, 0, endpoint) }
    }

    const text = await response.text()
    if (response.status === 304) {
      throw new EsiaError('ESI returned 304 but no cached response exists', { status: 304, code: 'HTTP' })
    }
    let data = this.parseBody(text)
    if (!this.isSuccess(response.status)) {
      throw this.normalizeError(endpoint, response.status, data, text)
    }

    // Cache success when an ETag or expiry is present.
    const etag = response.headers.get('etag')
    const expires = response.headers.get('expires')
    if (etag !== null || expires !== null) {
      this.cache.set(cacheKey, { etag, expiresAt: this.expiryMs(expires), data })
    }

    let totalPages: number | undefined
    const pagesHeader = response.headers.get('X-Pages')
    if (pagesHeader !== null && pagesHeader !== '') {
      totalPages = Number.parseInt(pagesHeader, 10)
    }

    if (options.pages === 'auto' && endpoint.paginated && totalPages !== undefined && totalPages > 1 && Array.isArray(data)) {
      const cap = this.config.maxPages ?? DEFAULT_MAX_PAGES
      const last = Math.min(totalPages, cap)
      const collected = [...data]
      for (let page = 2; page <= last; page += 1) {
        const pageUrl = this.withPage(request.url, page)
        const pageResponse = await this.fetchWithRetry(pageUrl, request.headers, request.body, options.signal)
        const pageText = await pageResponse.text()
        if (!this.isSuccess(pageResponse.status)) {
          throw this.normalizeError(endpoint, pageResponse.status, this.parseBody(pageText), pageText)
        }
        const pageData = this.parseBody(pageText)
        if (Array.isArray(pageData)) collected.push(...pageData)
      }
      data = collected
    }

    return { data, meta: this.meta(response, false, request.url, 1, 0, endpoint, totalPages) }
  }

  // ---- internals ----------------------------------------------------------

  private async buildRequest(endpoint: CatalogEndpoint, args: {
    pathParams?: Record<string, unknown>
    queryParams?: Record<string, unknown>
    body?: unknown
  }, options: EsiaCallOptions): Promise<BuiltRequest> {
    const pathParams = args.pathParams ?? {}
    const queryParams = args.queryParams ?? {}
    const server = this.serverProfile

    let path = endpoint.path
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1]
      if (name === undefined) continue
      const value = pathParams[name]
      if (value === undefined || value === null || value === '') {
        throw new EsiaError(
          `missing required path parameter "${name}" for ${endpoint.operationId} (${endpoint.path})`,
          { code: 'INVALID_ARGS' },
        )
      }
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)))
    }
    const base = `${server.esiBase}${path}`

    const query = new URLSearchParams()
    for (const param of endpoint.queryParams) {
      if (param.name === 'page') continue // managed by pagination
      const value = queryParams[param.name]
      if (value === undefined) {
        if (param.required) {
          throw new EsiaError(
            `missing required query parameter "${param.name}" for ${endpoint.operationId}`,
            { code: 'INVALID_ARGS' },
          )
        }
        continue
      }
      query.set(param.name, Array.isArray(value) ? value.join(',') : String(value))
    }
    query.set('datasource', server.datasource)
    if (options.language !== undefined) query.set('language', options.language)
    const url = `${base}?${query.toString()}`

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': DEFAULT_USER_AGENT,
    }
    if (endpoint.scopes.length > 0) {
      const token = this.config.tokenProvider ? await this.config.tokenProvider(endpoint.scopes) : undefined
      if (token !== undefined) headers.Authorization = `Bearer ${token}`
    }

    let body: string | undefined
    if (endpoint.body !== undefined) {
      if (args.body === undefined) {
        if (endpoint.body.required) {
          throw new EsiaError(
            `missing required request body for ${endpoint.operationId}`,
            { code: 'INVALID_ARGS' },
          )
        }
      } else {
        body = JSON.stringify(args.body)
        headers['Content-Type'] = 'application/json'
      }
    }

    return { url, headers, body }
  }

  private async fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal?: EsiaAbortSignal,
  ): Promise<EsiaResponseLike> {
    let retryCount = 0
    for (;;) {
      await this.pace()
      let response: EsiaResponseLike
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, body, signal })
      } catch (error) {
        if (retryCount >= this.maxRetries()) {
          throw new EsiaError(`network error calling ${url}: ${errorMessage(error)}`, {
            code: 'NETWORK',
            retryable: true,
          })
        }
        retryCount += 1
        await this.sleep(this.backoffMs(null, retryCount), signal)
        continue
      }
      if (!this.isRetryable(response.status) || retryCount >= this.maxRetries()) {
        return response
      }
      retryCount += 1
      await this.sleep(this.backoffMs(response, retryCount), signal)
    }
  }

  /** Sleep until the pacing window allows the next request. */
  private async pace(): Promise<void> {
    const rps = this.config.ratePerSecond ?? DEFAULT_RATE_PER_SECOND
    if (rps <= 0) return
    const now = Date.now()
    const interval = 1000 / rps
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt + interval)
    if (this.nextAllowedAt - now > 5000) this.nextAllowedAt = now + interval // drift guard
    const wait = this.nextAllowedAt - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  private isRetryable(status: number): boolean {
    return status === 420 || status === 520 || status >= 500
  }

  private backoffMs(response: EsiaResponseLike | null, retryCount: number): number {
    const retryAfter = response?.headers.get('Retry-After')
    if (retryAfter !== null && retryAfter !== undefined) {
      const seconds = Number.parseInt(retryAfter, 10)
      if (Number.isFinite(seconds)) return seconds * 1000
    }
    return Math.min(4000, 200 * 2 ** retryCount)
  }

  private maxRetries(): number {
    return this.config.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  private sleep(ms: number, signal?: EsiaAbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private withPage(url: string, page: number): string {
    const [base, query] = url.split('?', 2)
    const params = new URLSearchParams(query ?? '')
    params.set('page', String(page))
    return `${base}?${params.toString()}`
  }

  private parseBody(text: string): unknown {
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  private isSuccess(status: number): boolean {
    return status >= 200 && status < 300
  }

  private normalizeError(
    endpoint: CatalogEndpoint,
    status: number,
    body: unknown,
    rawText: string,
  ): EsiaError {
    const message = extractErrorMessage(body, rawText)
    const requiredScopes = endpoint.scopes
    switch (status) {
      case 400:
        return new EsiaError(`ESI 400: ${message}`, { status, code: 'BAD_REQUEST' })
      case 401:
        return new EsiaError(`ESI 401: ${message} — this endpoint requires EVE SSO authorization`, {
          status,
          code: 'UNAUTHORIZED',
          requiredScopes,
        })
      case 403:
        return new EsiaError(
          `ESI 403: ${message} — missing OAuth scopes: ${requiredScopes.join(', ') || '(none)'}; authorize them with esi_authorize`,
          { status, code: 'FORBIDDEN', requiredScopes },
        )
      case 404:
        return new EsiaError(`ESI 404: ${message}`, { status, code: 'NOT_FOUND' })
      case 420:
      case 520:
        return new EsiaError(`ESI ${status}: rate limited — ${message}`, {
          status,
          code: 'RATE_LIMITED',
          retryable: true,
        })
      default:
        if (status >= 500) {
          return new EsiaError(`ESI ${status}: server error — ${message}`, {
            status,
            code: 'SERVER_ERROR',
            retryable: true,
          })
        }
        return new EsiaError(`ESI ${status}: ${message}`, { status, code: 'HTTP' })
    }
  }

  private meta(
    response: EsiaResponseLike,
    cached: boolean,
    url: string,
    page: number,
    retryCount: number,
    endpoint: CatalogEndpoint,
    pages?: number,
  ): EsiaResultMeta {
    const expires = response.headers.get('expires')
    return {
      status: response.status,
      cached,
      page,
      ...(pages !== undefined ? { pages } : {}),
      ...(expires !== null ? { expires } : {}),
      retryCount,
      requiredScopes: [...endpoint.scopes],
      url,
    }
  }

  private expiryMs(expires: string | null): number {
    if (expires === null) return Date.now() + 60_000
    const parsed = Date.parse(expires)
    if (Number.isNaN(parsed)) return Date.now() + 60_000
    return parsed
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() > entry.expiresAt
  }
}

function extractErrorMessage(body: unknown, rawText: string): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  const collapsed = rawText.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed.slice(0, 300) : 'unknown error'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
