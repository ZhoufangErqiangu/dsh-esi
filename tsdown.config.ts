/**
 * Build the plugin into two bundles:
 * - `lib/index.js` (host half): ESM node bundle of the tools plugin. The
 *   host harness provides the peer packages at runtime, so they are never
 *   bundled — duplicating cordis/dsh-tools would break service identity.
 *   All relative modules are inlined; `node:` builtins stay external;
 *   `import.meta.url` of the bundle still sits one level under the package
 *   root, so the default SDE dataRoot (<pkg>/data) resolves identically.
 * - `lib/client.js` (browser half): CJS closure that registers itself with
 *   the browser module system via `window.__ModuleLoader__.load({id,
 *   factory})`, resolving externals through the injected require (the frozen
 *   module table). A self-contained replica of the harness client preset
 *   (`packages/client/tsdown.client.ts`), minus the CSS-modules pipeline
 *   (the card uses inline styles over theme variables).
 *
 * Plain object export (no tsdown import) so the config loads even when the
 * package's own node_modules does not yet contain tsdown (e.g. the first
 * `pnpm install` that triggers `prepare`).
 */

import type { UserConfig } from 'tsdown'

const ID = '@dsh-esi/plugin-esi'

/** Externals resolved from the loader module table: the platform seed entries plus the runtime exemption. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const host: UserConfig = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  // Keep .js/.d.ts names (the package is type: module): matches the exports map.
  fixedExtension: false,
  clean: true,
  dts: true,
  deps: {
    // The host harness provides the peer packages — never bundle them.
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'],
    // fflate (zip extraction for sde_update) is a runtime dependency: inline it
    // so the bundle is self-contained and consumers need nothing extra.
    alwaysBundle: ['fflate'],
  },
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ artifact dir;
  // the entryFileNames pin keeps it exactly lib/client.js). clean stays off —
  // a default clean would wipe the node-half output emitted above.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Only the loader module table is external; everything else inlines —
    // a require the table cannot answer is a runtime throw.
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The map is served from /plugins/<id>/client.js.map.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/**
 * ENV-selected config: DSH_BUILD_FACE host/client builds one half (mirrors
 * the harness build faces); no env builds both.
 */
export default ({ env }: { env?: Record<string, string | undefined> }): UserConfig[] => {
  const face = env?.DSH_BUILD_FACE
  if (face === 'host') return [host]
  if (face === 'client') return [client]
  return [host, client]
}
