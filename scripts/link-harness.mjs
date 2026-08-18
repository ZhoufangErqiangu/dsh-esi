/**
 * Link the harness-built packages the test/smoke/e2e suites need into
 * node_modules/@deepseek-ai. The harness checkout must sit at the sibling
 * path ../deepseek-harness (same layout the tsconfig typeRoots assume).
 *
 * Why: the suites import `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-scope`,
 * `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session` (the latter two because
 * `@deepseek-ai/dsh-tools`' built entry imports them). These are harness
 * workspace packages, not npm-published here; each one resolves its own
 * transitive deps from its own node_modules inside the harness, so linking
 * just these entry packages is sufficient.
 *
 * The browser half additionally type-checks against the client packages
 * (dsh-client-*) and the settings seam — not yet published to npm, so they
 * are linked from the harness checkout too. `fflate` (zip extraction) and the
 * build tools (tsdown, @types/react) are linked from the harness pnpm store.
 *
 * Idempotent and non-destructive: existing entries (copies or links) are left
 * untouched. Run after a fresh clone or after `rm -rf node_modules`:
 *
 *   node scripts/link-harness.mjs
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = join(repoRoot, '..', 'deepseek-harness')
const linkDir = join(repoRoot, 'node_modules', '@deepseek-ai')

// name -> path of the harness package directory (relative to harnessRoot)
const LINKS = {
  'dsh-scope': 'packages/core/scope',
  'dsh-system-prompt': 'packages/core/system-prompt',
  'dsh-llm': 'packages/llm/llm',
  'dsh-session': 'packages/core/session',
  // Host half: settings seam (settings namespace registration + watch).
  'dsh-settings': 'packages/settings/settings',
  // Browser half: client type surface used by src/client.
  'dsh-client-runtime': 'packages/client/runtime',
  'dsh-client-ui-slots': 'packages/client/ui-slots',
  'dsh-client-locale': 'packages/client/locale',
  'dsh-client-ui-settings': 'packages/client/ui-settings',
  'dsh-client-connection': 'packages/client/connection',
  'dsh-api-remotes': 'packages/api/remotes',
  'dsh-typert-protocol': 'packages/typert/protocol',
}

// Prebuilt copies that must already exist in node_modules/@deepseek-ai
// (cordis / dsh-tools / schemastery / cosmokit). We only check for them.
const BASES = ['cordis', 'dsh-tools', 'schemastery', 'cosmokit']

// Unscoped tools and @types linked from the harness pnpm store.
const PNPM_LINKS = [
  { name: 'fflate', storePath: 'node_modules/.pnpm/fflate@0.8.3/node_modules/fflate' },
  { name: 'tsdown', storePath: 'node_modules/.pnpm/tsdown@0.22.2_oxc-resolver@11.20.0_publint@0.3.21_tsx@4.22.4_typescript@6.0.3/node_modules/tsdown' },
]
const TYPES_LINKS = [
  { name: 'react', storePath: 'node_modules/.pnpm/@types+react@18.3.31/node_modules/@types/react' },
  { name: 'react-dom', storePath: 'node_modules/.pnpm/@types+react-dom@18.3.7_@types+react@18.3.31/node_modules/@types/react-dom' },
]

if (!existsSync(harnessRoot)) {
  console.error(`harness checkout not found at ${harnessRoot}`)
  console.error('the suites need the sibling deepseek-harness checkout (built lib/ dirs)')
  process.exit(1)
}

mkdirSync(linkDir, { recursive: true })

let created = 0
for (const [name, rel] of Object.entries(LINKS)) {
  const target = join(harnessRoot, rel)
  const linkPath = join(linkDir, name)
  if (!existsSync(target)) {
    console.warn(`skip ${name}: harness target missing at ${target}`)
    continue
  }
  if (existsSync(linkPath)) {
    const current = lstatSync(linkPath).isSymbolicLink()
      ? `symlink -> ${readlinkSync(linkPath)}`
      : 'real directory (copy)'
    console.log(`ok ${name}: present (${current})`)
    continue
  }
  const relTarget = relative(linkDir, target)
  symlinkSync(relTarget, linkPath, 'dir')
  created++
  console.log(`linked ${name} -> ${relTarget}`)
}

// Store links (tools / @types). The target is a path INSIDE the harness's
// pnpm store; Node resolves the linked package's own transitive deps from its
// real location, so a symlink is sufficient.
const linkStore = (dir, rows) => {
  mkdirSync(dir, { recursive: true })
  for (const row of rows) {
    const target = join(harnessRoot, row.storePath)
    const linkPath = join(dir, row.name)
    if (!existsSync(target)) {
      console.warn(`skip store link ${row.name}: harness target missing at ${target}`)
      continue
    }
    if (existsSync(linkPath)) {
      console.log(`ok ${row.name}: present`)
      continue
    }
    const relTarget = relative(dir, target)
    symlinkSync(relTarget, linkPath, 'dir')
    created++
    console.log(`linked ${row.name} -> ${relTarget}`)
  }
}
linkStore(join(repoRoot, 'node_modules'), PNPM_LINKS)
linkStore(join(repoRoot, 'node_modules', '@types'), TYPES_LINKS)

const missingBases = BASES.filter((name) => !existsSync(join(linkDir, name)))
if (missingBases.length > 0) {
  console.warn(`missing base packages (copy them from a harness build): ${missingBases.join(', ')}`)
}

console.log(`\n${created} link(s) created; suites ready: pnpm run test / node scripts/smoke.mjs / node scripts/e2e-real.mjs`)
