/**
 * Live acceptance run: boot the REAL `dsh web` profile with the built plugin
 * mounted by absolute path (`scripts/web-patch.yml`), then exercise the host
 * mount and the browser bridge over HTTP.
 *
 * This is the same loader/patch path a profile install uses; the only
 * difference is that the row names `lib/index.js` instead of the package, so
 * the run needs no profile mutation and no network.
 *
 * Usage (after `npm run build`):
 *   node scripts/acceptance.mjs
 *   DSH_BIN=/path/to/dsh node scripts/acceptance.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const dshBin = process.env.DSH_BIN ?? 'dsh'
const patch = join(repo, 'scripts', 'web-patch.yml')
const artifact = join(repo, 'lib', 'index.js')
const START_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 10_000

function fail(message) {
  console.error(`ACCEPTANCE FAIL: ${message}`)
  process.exit(1)
}

if (!existsSync(artifact)) fail(`missing ${artifact}; run "npm run build" first`)

const home = mkdtempSync(join(tmpdir(), 'dsh-esi-acceptance-',))
const child = spawn(dshBin, [
  'web',
  '--patch', patch,
  '--no-open',
  '--port', '0',
], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

const deadline = Date.now() + START_TIMEOUT_MS
let origin
while (origin === undefined) {
  if (Date.now() > deadline) fail(`dsh web did not print a URL within ${START_TIMEOUT_MS}ms:\n${output}`)
  if (child.exitCode !== null) fail(`dsh web exited (${child.exitCode}):\n${output}`)
  const match = /dsh web: (https?:\/\/[^\s]+)/.exec(output)
  if (match !== null) origin = new URL(match[1]).origin
  else await new Promise((resolve) => setTimeout(resolve, 200))
}
console.log('dsh web ok —', origin)

async function getState() {
  const response = await fetch(`${origin}/dsh-esi/api/state`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) fail(`bridge answered HTTP ${response.status}`)
  const body = await response.json()
  if (body.ok !== true) fail(`bridge answered ${JSON.stringify(body)}`)
  return body.state
}

let state
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    state = await getState()
    break
  } catch (error) {
    if (attempt === 99) fail(`bridge unreachable: ${String(error)}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
if (state.sde.available !== true) fail('SDE bridge section is not available')
if (state.account.available !== true) fail('account bridge section is not available')
if (state.sde.status.phase !== 'idle') fail(`unexpected SDE status ${state.sde.status.phase}`)
console.log('bridge ok — sde', state.sde.status.phase, '| regions', state.account.regions.length, '| characters', state.account.characters.length)

const update = await fetch(`${origin}/dsh-esi/api/sde/update`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
if (update.status !== 202) fail(`empty update should be accepted as a job, got ${update.status}`)
const after = await getState()
if (after.sde.status.phase !== 'error' || after.sde.status.error?.code !== 'URL_EMPTY') {
  fail(`empty update should publish URL_EMPTY, got ${JSON.stringify(after.sde.status)}`)
}
console.log('action ok — empty update URL reported as URL_EMPTY')

child.kill('SIGTERM')
await Promise.race([
  new Promise((resolve) => child.once('exit', resolve)),
  new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
])
rmSync(home, { recursive: true, force: true })
console.log('ACCEPTANCE PASS')
process.exit(0)
