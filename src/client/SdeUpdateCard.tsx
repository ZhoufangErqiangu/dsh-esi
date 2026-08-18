/**
 * The SDE-update settings card: a download-URL input, an update button, a
 * rollback button, and a live status area fed by the host through the
 * `dsh-esi` settings namespace.
 *
 * The card is self-contained (no imports beyond the platform module table):
 * markup is plain elements with inline styles over the theme CSS variables.
 */

import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SdeCardFace, SdeCardState, SdeGuiStatusView } from './sde-card-controller.ts'
import type { SdeCardLocaleKey } from './locales.ts'

/** Dictionary namespace owned by this card. */
export const LOCALE_NS = 'dsh-esi.sde-card'

/** Props the renderer binds for the card. `t` rides the inject face (bound at apply time). */
export type SdeUpdateCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<SdeCardFace>

const PHASE_KEYS: Record<string, SdeCardLocaleKey> = {
  idle: 'idle',
  checking: 'checking',
  downloading: 'downloading',
  extracting: 'extracting',
  building: 'building',
  installing: 'installing',
  done: 'done',
  error: 'error',
}

// ---- inline styles over the theme tokens -----------------------------------

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  padding: '10px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  fontWeight: 600,
  textAlign: 'left',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 2,
}

const descriptionStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
}

const fieldRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  fontFamily: 'var(--dsw-font-family)',
}

const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-dimmed)',
  fontSize: 11,
  lineHeight: 1.45,
  margin: 0,
}

const buttonBase: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 500,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
}

const primaryButton: CSSProperties = {
  ...buttonBase,
  background: 'var(--dsw-alias-brand-primary)',
  borderColor: 'transparent',
  color: 'var(--dsw-alias-brand-primary-invert)',
}

const disabledButton: CSSProperties = {
  ...buttonBase,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const statusRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const chipStyle: CSSProperties = {
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  border: '1px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
}

const trackStyle: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: 'var(--dsw-alias-bg-base)',
  overflow: 'hidden',
  flex: 1,
}

const errorStyle: CSSProperties = {
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-danger)',
  border: '1px solid var(--dsw-alias-border-l2)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/**
 * Render the SDE update card.
 * @param props - locale copy, the card snapshot, and its trigger actions.
 * @returns the card, or a notice when the namespace is unavailable.
 */
export function SdeUpdateCard(props: SdeUpdateCardProps) {
  const { t } = props
  const state = props.useSdeCard((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState<string | undefined>(undefined)

  if (!state.available) {
    return (
      <li style={cardStyle}>
        <div style={{ color: 'var(--dsw-alias-label-dimmed)', fontSize: 12 }}>{t('unavailable')}</div>
      </li>
    )
  }

  const startUpdate = (): void => {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) {
      setInvalid(t('invalidUrl'))
      return
    }
    setInvalid(undefined)
    props.runUpdate(trimmed)
  }

  const startRollback = (): void => {
    setInvalid(undefined)
    props.rollback()
  }

  const status = state.status
  const phaseKey = status === undefined ? undefined : PHASE_KEYS[status.phase]

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span>{t('title')}</span>
        <span aria-hidden style={{ fontSize: 10, color: 'var(--dsw-alias-label-dimmed)' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div style={bodyStyle}>
          <p style={descriptionStyle}>{t('description')}</p>

          <div style={fieldRowStyle}>
            <label htmlFor="dsh-esi-sde-url" style={labelStyle}>{t('urlLabel')}</label>
            <input
              id="dsh-esi-sde-url"
              type="text"
              style={inputStyle}
              value={url}
              disabled={state.busy || !state.writable}
              placeholder={t('urlPlaceholder')}
              onChange={(event) => { setUrl(event.target.value) }}
            />
          </div>

          <div style={fieldRowStyle}>
            <button
              type="button"
              style={state.busy ? disabledButton : primaryButton}
              disabled={state.busy || !state.writable}
              onClick={startUpdate}
            >
              {t('update')}
            </button>
            <button
              type="button"
              style={state.busy ? disabledButton : buttonBase}
              disabled={state.busy || !state.writable}
              onClick={startRollback}
            >
              {t('rollback')}
            </button>
            <span style={hintStyle}>{t('rollbackHint')}</span>
          </div>

          {invalid !== undefined && <div style={errorStyle}>{invalid}</div>}
          {status === undefined && (
            <div style={statusRowStyle}><span>{t('noStatus')}</span></div>
          )}
          {status !== undefined && (
            <div style={statusRowStyle}>
              <span style={chipStyle}>
                {phaseKey === undefined ? status.phase : t(phaseKey)}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {status.message}
              </span>
              {status.progress !== undefined && (
                <div style={trackStyle} role="progressbar" aria-valuenow={Math.round(status.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{
                    height: '100%',
                    width: `${Math.round(Math.min(1, Math.max(0, status.progress)) * 100)}%`,
                    background: 'var(--dsw-alias-brand-primary)',
                  }} />
                </div>
              )}
            </div>
          )}
          {status?.error !== undefined && status.error.message !== undefined && (
            <div style={errorStyle} role="alert">
              {status.error.message}
            </div>
          )}
        </div>
      )}
    </li>
  )
}
