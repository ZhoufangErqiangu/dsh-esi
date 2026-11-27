/**
 * Structural check of the BUILT browser bundle (`lib/client.js`) without a
 * browser: execute the loader registration, run `apply`, and render the tab
 * with stub React primitives.
 *
 * This catches the failures a typecheck cannot: a wrong loader id, a missing
 * slot id/label, a component that throws while building its element tree, or
 * a runtime `require` the module table cannot answer. It does not verify CSS,
 * layout, or the real page; see README "Debugging".
 *
 * Usage: node scripts/verify-client.mjs   (after `npm run build`)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = process.env.DSH_ESI_CLIENT_BUNDLE ?? join(repo, 'lib', 'client.js')

function fail(message) {
  console.error(`CLIENT VERIFY FAIL: ${message}`)
  process.exit(1)
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { registration = value },
  },
}

// ---- minimal React surface the bundle requires -----------------------------
const noop = () => {}
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length > 1 ? children : children[0] } }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
  useEffect: noop,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const jsxRuntime = {
  Fragment: 'Fragment',
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  fail(`bundle required "${specifier}", which is not in the stubbed module table`)
}

try {
  const source = readFileSync(bundle, 'utf8')
  if (!source.includes('window.__ModuleLoader__.load')) fail('bundle does not use the loader registration protocol')
  // Execute in this realm; the bundle is a self-contained CJS closure.
  new Function('window', 'require', source)(globalThis.window, requireStub)
} catch (error) {
  fail(`bundle evaluation threw: ${error?.stack ?? error}`)
}

if (registration === undefined) fail('bundle did not call window.__ModuleLoader__.load')
if (registration.id !== '@dsh-esi/plugin-esi') fail(`loader id is ${JSON.stringify(registration.id)}`)
console.log('loader registration ok —', registration.id)

const exports = registration.factory(requireStub)
if (typeof exports.apply !== 'function') fail('client entry exports no apply')
if (!Array.isArray(exports.inject) || !exports.inject.includes('slots') || !exports.inject.includes('locale')) {
  fail(`unexpected service injection ${JSON.stringify(exports.inject)}`)
}

// ---- fake client context ---------------------------------------------------
const registrations = []
const dictionaryNamespaces = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (namespace) => {
      dictionaryNamespaces.push(namespace)
      return noop
    },
    bind: (namespace) => (key, params) => {
      if (params === undefined) return key
      return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), key)
    },
  },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return noop
    },
  },
}

try {
  exports.apply(ctx)
} catch (error) {
  fail(`apply threw: ${error?.stack ?? error}`)
}

if (dictionaryNamespaces.length !== 2) fail(`expected 2 locale namespaces, got ${JSON.stringify(dictionaryNamespaces)}`)
const tab = registrations.find((entry) => entry.options?.name === 'settings.plugins.tab')
if (tab === undefined) fail('apply registered no settings.plugins.tab entry')
if (tab.options.id !== 'dsh-esi') fail(`tab id is ${JSON.stringify(tab.options.id)}`)
if (typeof tab.options.label !== 'function') fail('tab label must be a locale-following thunk')
const bundleConfig = registrations.find((entry) => entry.options?.name === 'plugins.bundle.config')
if (bundleConfig === undefined) fail('apply registered no plugins.bundle.config entry (the Plugins page would show no configuration)')
if (bundleConfig.options.key !== '@dsh-esi/plugin-esi') fail(`bundle config key is ${JSON.stringify(bundleConfig.options.key)}`)
console.log('slot registration ok — settings.plugins.tab /', tab.options.id, '+ plugins.bundle.config /', bundleConfig.options.key)

const face = tab.options.inject()
if (typeof face.createClient !== 'function' || typeof face.tSde !== 'function' || typeof face.tAccount !== 'function') {
  fail('inject face is incomplete')
}
if (bundleConfig.options.inject !== undefined) {
  const bundleFace = bundleConfig.options.inject()
  if (typeof bundleFace.createClient !== 'function') fail('bundle config inject face is incomplete')
}

// ---- render the tab with stub primitives -----------------------------------
function fakeClient(snapshot) {
  return {
    start: noop,
    stop: noop,
    getSnapshot: () => snapshot,
    subscribe: () => noop,
    runUpdate: noop,
    rollback: noop,
    login: noop,
    deauth: noop,
    setRegion: noop,
  }
}
const idleSde = { phase: 'idle', message: '尚未安装 SDE 数据', messageKey: 'status.idle.noData', at: Date.now() }
const baseSnapshot = {
  sde: { available: true, status: idleSde, versions: [], defaultUpdateUrl: undefined, busy: false, failed: false },
  account: {
    available: true,
    regions: [{ id: 10000002, name: 'The Forge (Jita)' }],
    regionId: 10000002,
    characters: [{ characterId: 1, characterName: 'Pilot', scopes: ['a'], expiresAt: Date.now() + 1000, expired: false }],
    status: { phase: 'idle', messageKey: 'status.idle.authorized', message: '已授权角色可正常使用', at: Date.now() },
    busy: false,
  },
  error: undefined,
}

function textOf(node, found = []) {
  if (node === undefined || node === null || node === false) return found
  if (typeof node === 'string' || typeof node === 'number') { found.push(String(node)); return found }
  if (Array.isArray(node)) { for (const child of node) textOf(child, found); return found }
  if (typeof node === 'object') {
    // Function elements are invoked here (no React renderer): stubs only.
    if (typeof node.type === 'function') return textOf(node.type(node.props), found)
    textOf(node.props?.children, found)
  }
  return found
}

function render(snapshot, view = 'page') {
  return tab.component({
    ...face,
    view,
    createClient: () => fakeClient(snapshot),
  })
}

try {
  const summary = render(baseSnapshot, 'summary')
  if (summary !== null) fail(`bundle summary view should render nothing, got ${JSON.stringify(summary)}`)
  const loading = render(
    { ...baseSnapshot, sde: { ...baseSnapshot.sde, available: false }, account: { ...baseSnapshot.account, available: false } },
    'page',
  )
  const loadingText = textOf(loading).join('|')
  if (!loadingText.includes('bridgeLoading')) fail(`unavailable state should render bridgeLoading, got ${JSON.stringify(loadingText)}`)
  const rendered = render(baseSnapshot)
  const text = textOf(rendered).join('|')
  // Cards render collapsed by default, so the header copy is what mounts.
  for (const key of ['title', 'description', 'accountTitle', 'accountDescription']) {
    if (!text.includes(key)) fail(`rendered tab is missing ${key}: ${JSON.stringify(text.slice(0, 400))}`)
  }
} catch (error) {
  fail(`component render threw: ${error?.stack ?? error}`)
}
console.log('component render ok — cards and status lines built')

console.log('CLIENT VERIFY PASS')
process.exit(0)
