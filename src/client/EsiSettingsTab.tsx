/**
 * The `EVE ESI` cards, registered in two places so users find them where they
 * look for plugin settings:
 *
 * - `plugins.bundle.config` (keyed by the bundle name) on the bundle's page in
 *   the Plugins panel — the canonical home for a bundle's own configuration in
 *   DSH 0.2.2, and what makes the page treat this bundle as configurable;
 * - `settings.plugins.tab` in Settings → Plugins, for discoverability from the
 *   settings dialog.
 *
 * Each mounted copy owns its own polling client (the two surfaces are never
 * visible at once, and unmounting one must not stop the other). Polling also
 * pauses whenever the copy is off screen because the shell keeps visited
 * panels and tabs mounted.
 *
 * @module @dsh-esi/plugin-esi/client
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { hint, invalidText } from './card-chrome.tsx'
import { SdeUpdateCard } from './SdeUpdateCard.tsx'
import { EveAccountCard } from './EveAccountCard.tsx'
import type { EsiTabSnapshot, EsiUiClient } from './esi-ui-client.ts'
import type { EveAccountLocaleKey, SdeCardLocaleKey } from './locales.ts'

/** The registration-side face the two slot entries inject. */
export interface EsiTabFace {
  /** Build one polling client for one mounted copy of the cards. */
  createClient(): EsiUiClient
  readonly tSde: (key: SdeCardLocaleKey, params?: Record<string, unknown>) => string
  readonly tAccount: (key: EveAccountLocaleKey, params?: Record<string, unknown>) => string
}

/** Props the renderer binds; `view` is supplied only by the bundle page. */
export interface EsiSettingsTabProps extends EsiTabFace {
  /** `summary` asks for a one-liner (the cards render nothing); `page` for the form. */
  readonly view?: 'summary' | 'page'
}

const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

/** Render both plugin cards; polling follows this mounted copy's visibility. */
export function EsiSettingsTab(props: EsiSettingsTabProps) {
  const clientRef = useRef<EsiUiClient | undefined>(undefined)
  if (clientRef.current === undefined) clientRef.current = props.createClient()
  const client = clientRef.current

  const store = useMemo(() => ({
    subscribe: (listener: () => void) => client.subscribe(listener),
    getSnapshot: () => client.getSnapshot(),
  }), [client])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    client.start()
    const element = host.current
    // The shell keeps visited tabs and panels mounted but hidden; pause polling
    // while this copy is off screen and resume when it returns.
    if (element === null || typeof IntersectionObserver === 'undefined') {
      return () => { client.stop() }
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting === true) client.start()
      else client.stop()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      client.stop()
    }
  }, [client])

  // The bundle page asks for a one-line summary before rendering the page form.
  if (props.view !== undefined && props.view !== 'page') return null

  const { tSde, tAccount } = props

  return (
    <div ref={host} style={stack}>
      {!snapshot.sde.available
        ? (
            <p style={hint}>
              {snapshot.error === undefined ? tSde('bridgeLoading') : tSde('bridgeError')}
            </p>
          )
        : (
            <>
              {snapshot.error !== undefined && (
                <p style={invalidText} role="alert">{snapshot.error}</p>
              )}
              <SdeUpdateCard
                t={tSde}
                state={snapshot.sde}
                onUpdate={(url) => client.runUpdate(url)}
                onRollback={() => client.rollback()}
              />
              <EveAccountCard
                t={tAccount}
                state={snapshot.account}
                onLogin={() => client.login()}
                onDeauth={(characterId) => client.deauth(characterId)}
                onSetRegion={(regionId) => client.setRegion(regionId)}
              />
            </>
          )}
    </div>
  )
}

export type { EsiTabSnapshot }
