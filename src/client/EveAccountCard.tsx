/**
 * The EVE account & market settings card: EVE SSO login (the card arms the
 * flow, the host publishes the login URL + status, the card opens it), the
 * authorized character list with per-character revocation, and the default
 * market region picker (catalog served by the host in the namespace base).
 */

import type { CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CardFrame, field, fieldHead, fieldLabel, fieldSeparated, hint, invalidText,
  inputBase, primaryButton, secondaryButton,
} from './card-chrome.tsx'
import type { EveAccountCardFace } from './eve-account-card-controller.ts'

/** Dictionary namespace owned by this card. */
export const ACCOUNT_LOCALE_NS = 'dsh-esi.eve-account'

/** Props the renderer binds for the card. */
export type EveAccountCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<EveAccountCardFace>

const charList: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const charRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  lineHeight: 1.5,
}

const charName: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const charMeta: CSSProperties = {
  margin: 0,
  flex: 'none',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const miniButton: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  padding: '2px 10px',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const actionRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const loginLink: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}

const statusMessage: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
}

const selectStyle: CSSProperties = {
  ...inputBase,
  appearance: 'none',
}

/**
 * Render the EVE account & market card.
 * @param props - locale copy, the card snapshot, and its trigger actions.
 * @returns the card.
 */
export function EveAccountCard(props: EveAccountCardProps) {
  const { t } = props
  const state = props.useEveAccountCard((snapshot) => snapshot)

  if (!state.available) return null

  const locked = !state.writable
  const busy = state.busy
  const status = state.status

  return (
    <CardFrame
      title={t('accountTitle')}
      description={t('accountDescription')}
      expandLabel={t('expand')}
      collapseLabel={t('collapse')}
    >
      {/* authorized characters */}
      <div style={field}>
        <div style={fieldHead}>
          <span style={fieldLabel}>{t('charactersLabel')}</span>
        </div>
        {state.characters.length === 0
          ? <p style={hint}>{t('noCharacters')}</p>
          : (
            <ul style={charList}>
              {state.characters.map((character) => (
                <li key={character.characterId} style={charRow}>
                  <span style={charName}>
                    {character.characterName}
                    {character.expired ? t('expired') : ''}
                  </span>
                  <span style={charMeta}>
                    {t('scopesCount').replace('{n}', String(character.scopes.length))}
                  </span>
                  <button
                    type="button"
                    style={miniButton}
                    disabled={locked}
                    onClick={() => { props.deauth(character.characterId) }}
                  >
                    {t('deauth')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        {state.characters.length > 1 && (
          <div>
            <button
              type="button"
              style={miniButton}
              disabled={locked}
              onClick={() => { props.deauth() }}
            >
              {t('deauthAll')}
            </button>
          </div>
        )}
      </div>

      {/* EVE login */}
      <div style={fieldSeparated}>
        <div style={actionRow}>
          <button
            type="button"
            style={busy || locked ? { ...primaryButton, opacity: 0.4, cursor: 'default' } : primaryButton}
            disabled={busy || locked}
            onClick={() => { props.login() }}
          >
            {busy ? t('loginBusy') : t('login')}
          </button>
          {status?.loginUrl !== undefined && (
            <a href={status.loginUrl} target="_blank" rel="noreferrer" style={loginLink}>
              {t('openLoginUrl')}
            </a>
          )}
        </div>
        {status !== undefined && <p style={statusMessage}>{status.message}</p>}
        {status?.error !== undefined && status.error.message !== undefined && (
          <p style={invalidText} role="alert">{status.error.message}</p>
        )}
      </div>

      {/* default market region */}
      <div style={fieldSeparated}>
        <div style={fieldHead}>
          <label htmlFor="dsh-esi-market-region" style={fieldLabel}>{t('defaultRegionLabel')}</label>
        </div>
        <select
          id="dsh-esi-market-region"
          style={selectStyle}
          value={state.regionId ?? ''}
          disabled={locked}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isInteger(next) && next > 0) props.setRegion(next)
          }}
        >
          <option value="">{t('noRegion')}</option>
          {state.regions.map((region) => (
            <option key={region.id} value={region.id}>{region.name}</option>
          ))}
        </select>
        <p style={hint}>{t('defaultRegionHint')}</p>
      </div>
    </CardFrame>
  )
}
