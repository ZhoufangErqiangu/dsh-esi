/**
 * Types for the generated ESI endpoint catalog (`src/generated/catalog.ts`).
 *
 * The catalog is the single source of truth derived from `public/json/esi.json`
 * by `scripts/gen-catalog.mjs`. Runtime consumers (endpoint search, the
 * `esi_call` dispatcher, and the `esi_endpoint_load` materializer) read only
 * these shapes — never the raw swagger.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type ServerId = 'cn' | 'global'

/** One endpoint parameter, already resolved from swagger `$ref`s. */
export interface CatalogParam {
  readonly name: string
  readonly required: boolean
  readonly type: 'integer' | 'number' | 'string' | 'boolean' | 'array'
  /** Present when the swagger constrains the value set. */
  readonly enum?: readonly (string | number)[]
  /** Whitespace-collapsed, truncated description; '' when the spec had none. */
  readonly description: string
}

/** Request body declared by an operation (`in: body`). */
export interface CatalogBody {
  readonly required: boolean
  readonly description: string
  /** The raw inline JSON schema from the swagger (validated at call time by the dispatcher). */
  readonly schema: unknown
}

/** One ESI endpoint (one swagger operation). */
export interface CatalogEndpoint {
  readonly operationId: string
  readonly method: HttpMethod
  /** Path template with `{param}` placeholders, e.g. `/characters/{character_id}/assets/`. */
  readonly path: string
  /** Swagger tags (domain groups such as Character, Market, Industry). */
  readonly tags: readonly string[]
  readonly summary: string
  /** EVE SSO scopes required to call this endpoint; empty for public endpoints. */
  readonly scopes: readonly string[]
  /** Path parameters in template order; every `{var}` in `path` has an entry. */
  readonly pathParams: readonly CatalogParam[]
  /** Query parameters; dispatcher-managed ones (datasource/token/If-None-Match/Accept-Language) are excluded. */
  readonly queryParams: readonly CatalogParam[]
  readonly body?: CatalogBody
  /** True when the endpoint takes a `page` query parameter (X-Pages pagination). */
  readonly paginated: boolean
}

/** One ESI server profile (CN mirror vs global Tranquility). */
export interface CatalogServer {
  readonly id: ServerId
  readonly label: string
  /** ESI REST base, without trailing slash, e.g. `https://ali-esi.evepc.163.com`. */
  readonly esiBase: string
  /** EVE SSO login base, e.g. `https://login.evepc.163.com`. */
  readonly loginBase: string
  /** Datasource query value the dispatcher injects for this server. */
  readonly datasource: string
  /** Allowed datasource values (CN mirror offers serenity/infinity). */
  readonly datasourceOptions: readonly string[]
  /** Accepted `language` query values for localized responses. */
  readonly languageOptions: readonly string[]
}

/** One EVE SSO scope with its description. */
export interface CatalogScope {
  readonly scope: string
  readonly description: string
}

/** A domain tag with its endpoint count. */
export interface CatalogTag {
  readonly name: string
  readonly count: number
}

/** The complete generated catalog. */
export interface Catalog {
  readonly swaggerVersion: string
  readonly servers: Record<ServerId, CatalogServer>
  readonly endpoints: readonly CatalogEndpoint[]
  /** operationId → index into `endpoints`, for O(1) lookup. */
  readonly endpointIndex: Readonly<Record<string, number>>
  readonly tags: readonly CatalogTag[]
  readonly scopes: readonly CatalogScope[]
}
