/**
 * dsh-esi browser half: contributes two settings cards into the Plugins
 * settings section (`settings.plugin.item` slot, keyed by namespace):
 * - `dsh-esi`        → the SDE-update card
 * - `dsh-esi-account` → the EVE account & market card
 * Each card binds the settings namespace the host half registers — the cards
 * never talk to the host directly, so no harness RPC surface is involved.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only merges: the slot-map contract (slots), the locale registry
// (ctx.locale), and the settings scope binder (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SdeUpdateCard, LOCALE_NS } from './SdeUpdateCard.tsx'
import { SdeCardController, type SdeGuiSection } from './sde-card-controller.ts'
import { EveAccountCard, ACCOUNT_LOCALE_NS } from './EveAccountCard.tsx'
import { EveAccountCardController, type EveAccountSection } from './eve-account-card-controller.ts'
import { en, enAccount, zh, zhAccount } from './locales.ts'

// The `settings.plugin.item` slot type is owned by the shipped
// ui-settings-plugins package; the browser half of dsh-esi cannot value-import
// that package (client bundle purity gate), so the same additive declaration
// is restated here. The slot is KEYED by the settings namespace the card
// edits: the configurable tab dispatches each served namespace and renders
// the card registered under that key.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section, keyed by the namespace it edits. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }
}

/** Services the fiber injects (mirrors the package.json dsh.client list). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** The settings namespaces the cards bind; spelled here to match the host half. */
export const SDE_NS = 'dsh-esi'
export const ACCOUNT_NS = 'dsh-esi-account'

/** Mount both cards into the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }) && ctx.locale.register(ACCOUNT_LOCALE_NS, { zh: zhAccount, en: enAccount }),
    'dsh-esi: card dictionaries',
  )

  const sdeT = ctx.locale.bind(LOCALE_NS)
  const sdeController = new SdeCardController(
    ctx.settingsScope.bind<SdeGuiSection>({ namespace: SDE_NS }),
    sdeT,
  )

  const accountT = ctx.locale.bind(ACCOUNT_LOCALE_NS)
  const accountController = new EveAccountCardController(
    ctx.settingsScope.bind<EveAccountSection>({ namespace: ACCOUNT_NS }),
    accountT,
  )

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: ACCOUNT_NS,
      inject: () => accountController.inject(),
    }, EveAccountCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SDE_NS,
      inject: () => sdeController.inject(),
    }, SdeUpdateCard)
  })
}
