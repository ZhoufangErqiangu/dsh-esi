/**
 * dsh-esi browser half: the `EVE ESI` cards, contributed both to the bundle's
 * page in the Plugins panel (`plugins.bundle.config`) and to the Plugins tab
 * of the Settings dialog (`settings.plugins.tab`).
 *
 * DSH 0.2 owns plugin configuration pages itself: a bundle's own page renders
 * `plugins.bundle.config` keyed by package name, and the page's config ledger
 * only treats the bundle as configurable when that entry exists. The old
 * ad-hoc settings namespaces are gone, so the cards poll the plugin's JSON
 * bridge instead of writing a settings document.
 *
 * @module @dsh-esi/plugin-esi/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: the slot-map contracts (Plugins page bundle config +
// Settings Plugins tab), the renderer service (ctx.slots), and the locale
// registry (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EsiSettingsTab, type EsiTabFace } from './EsiSettingsTab.tsx'
import { EsiUiClient } from './esi-ui-client.ts'
import { en, enAccount, zh, zhAccount } from './locales.ts'

/** Services the fiber injects. */
export const inject = ['slots', 'locale']

/** The bundle this package installs as; the key of `plugins.bundle.config`. */
const BUNDLE_NAME = '@dsh-esi/plugin-esi'

/** Dictionary namespace of the SDE-update card. */
export const SDE_NS = 'dsh-esi.sde-card'
/** Dictionary namespace of the EVE account & market card. */
export const ACCOUNT_NS = 'dsh-esi.eve-account'

/** Order of the Settings tab among the Plugins-page tabs. */
const TAB_ORDER = 40

/** Mount the cards on the plugin's own page and in the Settings Plugins tab. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(SDE_NS, { zh, en }), 'dsh-esi: sde card dictionary')
  ctx.effect(
    () => ctx.locale.register(ACCOUNT_NS, { zh: zhAccount, en: enAccount }),
    'dsh-esi: account card dictionary',
  )

  const sdeT = ctx.locale.bind(SDE_NS)
  const accountT = ctx.locale.bind(ACCOUNT_NS)
  const face = (): EsiTabFace => ({
    createClient: () => new EsiUiClient(),
    tSde: sdeT,
    tAccount: accountT,
  })

  // Canonical home: the bundle's page in the Plugins panel. The config ledger
  // keys this by package name and renders it as the page's configuration form.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    inject: face,
  }, EsiSettingsTab))

  // Discoverability: the same cards as a tab in Settings → Plugins.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'dsh-esi',
    order: TAB_ORDER,
    // A thunk so the tab follows the active locale without re-registration.
    label: () => sdeT('tabLabel'),
    inject: face,
  }, EsiSettingsTab))
}
