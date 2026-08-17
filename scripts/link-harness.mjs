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
 * just these four entry packages is sufficient.
 *
 * `fflate` (zip extraction for the URL-driven SDE update) is linked from the
 * harness pnpm store — it has no dependencies, so a symlink is safe.
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
}

// Prebuilt copies that must already exist in node_modules/@deepseek-ai
// (cordis / dsh-tools / schemastery / cosmokit). We only check for them.
const BASES = ['cordis', 'dsh-tools', 'schemastery', 'cosmokit']

// Unscoped tools linked from the harness pnpm store.
const PNPM_LINKS = [
  { name: 'fflate', storePath: 'node_modules/.pnpm/fflate@0.8.3/node_modules/fflate' },
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

// Store links (unscoped tools). The target is a path INSIDE the harness's
// pnpm store; Node resolves the linked package's own transitive deps from its
// real location, so a symlink is sufficient.
mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
for (const row of PNPM_LINKS) {
  const target = join(harnessRoot, row.storePath)
  const linkPath = join(repoRoot, 'node_modules', row.name)
  if (!existsSync(target)) {
    console.warn(`skip store link ${row.name}: harness target missing at ${target}`)
    continue
  }
  if (existsSync(linkPath)) {
    console.log(`ok ${row.name}: present`)
    continue
  }
  const relTarget = relative(join(repoRoot, 'node_modules'), target)
  symlinkSync(relTarget, linkPath, 'dir')
  created++
  console.log(`linked ${row.name} -> ${relTarget}`)
}

const missingBases = BASES.filter((name) => !existsSync(join(linkDir, name)))
if (missingBases.length > 0) {
  console.warn(`missing base packages (copy them from a harness build): ${missingBases.join(', ')}`)
}

console.log(`\n${created} link(s) created; suites ready: pnpm run test / node scripts/smoke.mjs / node scripts/e2e-real.mjs`)
