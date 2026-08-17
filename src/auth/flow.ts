/**
 * EVE SSO authorization flow (implicit grant, per the bundled swagger).
 *
 * The plugin starts a loopback HTTP server, opens (or prints) the EVE login
 * URL with redirect_uri pointing at `http://127.0.0.1:<port>/callback`, and
 * serves a tiny capture page there. The login redirects the browser to that
 * page with the token in the URL fragment; the page's JavaScript POSTs the
 * fragment to `/capture`, which resolves the pending authorization.
 *
 * The redirect URI must be registered in the EVE developer app; the port is
 * configurable (default 32418).
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { EsiaAbortSignal, EsiaFetch, EsiaFetchInit } from '../esia-client.ts'

export interface AuthFlowConfig {
  /** Login base, e.g. `https://login.evepc.163.com` (no trailing slash). */
  loginBase: string
  clientId: string
  redirectUri: string
  /** EVE SSO scopes to request (space-joined in the authorize URL). */
  scopes: readonly string[]
  fetchImpl?: EsiaFetch
}

export interface AuthorizeOutcome {
  readonly accessToken: string
  readonly expiresIn: number
}

export interface PendingAuth {
  /** Full authorize URL the user must open. */
  readonly url: string
  /** Settles with the token when the browser completes the login. */
  readonly result: Promise<AuthorizeOutcome>
  /** Stop the loopback server and reject pending waits. */
  close(): void
}

const CAPTURE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>DSH ESI authorization</title>
<body style="font-family:sans-serif;padding:2rem">
<h2>EVE SSO authorization</h2>
<p id="status">Handing the token back to DSH…</p>
<script>
  const params = new URLSearchParams(location.hash.slice(1))
  const payload = Object.fromEntries(params.entries())
  fetch('/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((res) => {
    document.getElementById('status').textContent = res.ok
      ? 'Authorization captured. You can close this window.'
      : 'Capture failed — close this window and tell the assistant.'
  }).catch(() => {
    document.getElementById('status').textContent = 'Capture failed — close this window and tell the assistant.'
  })
</script>
`

/**
 * Start one authorization flow: loopback server + login URL.
 * The returned `result` resolves with the token or rejects with an error
 * (including the authorize URL) when the user cancels or the wait times out.
 */
export function startAuthorizeFlow(config: AuthFlowConfig): PendingAuth {
  const url = new URL(config.redirectUri)
  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid redirect_uri "${config.redirectUri}" — must include a numeric port`)
  }
  const host = url.hostname
  const state = randomBytes(16).toString('hex')

  let settle: (outcome: AuthorizeOutcome) => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  const result = new Promise<AuthorizeOutcome>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const server: Server = createServer((req, res) => {
    const requestUrl = req.url ?? '/'
    if (req.method === 'GET' && requestUrl.startsWith('/callback')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(CAPTURE_PAGE)
      return
    }
    if (req.method === 'POST' && requestUrl.startsWith('/capture')) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        } catch {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        if (payload.state !== state) {
          res.statusCode = 400
          res.end('state mismatch')
          return
        }
        res.statusCode = 200
        res.end('ok')
        if (typeof payload.error === 'string') {
          const description = typeof payload.error_description === 'string' ? payload.error_description : ''
          fail(new Error(`EVE SSO authorization failed: ${payload.error}${description ? ` — ${description}` : ''}`))
          return
        }
        const accessToken = payload.access_token
        const expiresIn = Number(payload.expires_in ?? 0)
        if (typeof accessToken !== 'string' || accessToken === '') {
          fail(new Error('EVE SSO returned no access_token'))
          return
        }
        settle({ accessToken, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0 })
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  let closed = false
  let listenError: Error | undefined
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error) => {
      listenError = error
      reject(error)
    })
    server.listen(port, host, () => resolve())
  })

  const authorizeUrl = new URL(`${config.loginBase}/v2/oauth/authorize`)
  authorizeUrl.searchParams.set('response_type', 'token')
  authorizeUrl.searchParams.set('client_id', config.clientId)
  authorizeUrl.searchParams.set('redirect_uri', config.redirectUri)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', config.scopes.join(' '))

  return {
    url: authorizeUrl.toString(),
    result: listening.then(() => result),
    close(): void {
      if (closed) return
      closed = true
      server.close()
      fail(new Error('authorization cancelled'))
    },
  }
}

/**
 * Verify the token against the EVE SSO `/oauth/verify` endpoint and return the
 * character identity. Throws on network/HTTP failure.
 */
export async function verifyCharacter(
  loginBase: string,
  accessToken: string,
  fetchImpl?: EsiaFetch,
  signal?: EsiaAbortSignal,
): Promise<{ characterId: number; characterName: string; scopes: string[]; expiresOn: number }> {
  const doFetch = fetchImpl
    ?? ((input: string, init?: EsiaFetchInit) => fetch(input, init as RequestInit)) as unknown as EsiaFetch
  const response = await doFetch(`${loginBase}/oauth/verify`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`EVE SSO verify failed (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(`EVE SSO verify failed (HTTP ${response.status}): ${String(body.error ?? body.message ?? text).slice(0, 200)}`)
  }
  const characterId = Number(body.CharacterID)
  const characterName = String(body.CharacterName ?? '')
  if (!Number.isFinite(characterId) || characterId <= 0) {
    throw new Error(`EVE SSO verify returned no valid CharacterID: ${text.slice(0, 200)}`)
  }
  const rawScopes = typeof body.Scopes === 'string' ? body.Scopes.split(' ') : []
  const expiresOn = Number(body.ExpiresOn)
  return {
    characterId,
    characterName,
    scopes: rawScopes.filter((scope) => scope.length > 0),
    expiresOn: Number.isFinite(expiresOn) ? expiresOn : Date.now() + 20 * 60_000,
  }
}
