/**
 * Build the plugin into a single ESM bundle at lib/index.js.
 *
 * The host harness provides the peer packages at runtime, so they are never
 * bundled — duplicating cordis/dsh-tools would break service identity. All
 * relative modules (catalog, prompt, sde, tools, auth) are inlined, and
 * node: builtins stay external. `import.meta.url` of the bundle still sits one
 * level under the package root, so the default SDE dataRoot (<pkg>/data)
 * resolves identically to the source layout.
 *
 * Plain object export (no tsdown import) so the config loads even when the
 * package's own node_modules does not yet contain tsdown (e.g. the first
 * `pnpm install` that triggers `prepare`).
 */
export default {
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
