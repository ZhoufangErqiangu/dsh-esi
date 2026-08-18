/**
 * The SDE-update settings card: a download-URL input, an update button, a
 * rollback button, and a live status area fed by the host through the
 * `dsh-esi` settings namespace.
 *
 * Visual language mirrors the shipped plugin cards (PluginCard.tsx /
 * fields.tsx in ui-settings-plugins): same container tokens (border-l2 /
 * bg-layer-3, 12px radius, disclosure header with name over description and
 * a rotating chevron), the same field treatment (label over a 34px
 * layer-3 input with border-l2, hint in label-tertiary), and the same
 * footer buttons (ghost discard-style secondary, label-primary save-style
 * primary). The card stays self-contained (no imports beyond the platform
 * module table), so these are inline styles over the theme variables.
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

// ---- official card chrome (PluginCard.module.css) over inline styles -------

const card: CSSProperties = {
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

const cardOpen: CSSProperties = {
  ...card,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const cardHover: CSSProperties = {
  ...card,
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const cardOpenHover: CSSProperties = {
  ...cardOpen,
}

const header: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
}

const headText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const name: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}

const description: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const chevron: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform .16s',
}

const chevronOpen: CSSProperties = {
  ...chevron,
  transform: 'rotate(180deg)',
}

const body: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingBottom: 8,
}

// ---- official field treatment (fields.module.css) --------------------------

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
}

const fieldHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const fieldLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const inputBase: CSSProperties = {
  height: 34,
  padding: '0 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const inputFocus: CSSProperties = {
  ...inputBase,
  borderColor: 'var(--dsw-alias-brand-primary)',
}

const inputDisabled: CSSProperties = {
  ...inputBase,
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'default',
}

const hint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const invalidTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-error)',
}

// ---- status area ------------------------------------------------------------

const statusRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 0 12px',
}

const badge: CSSProperties = {
  flex: 'none',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  lineHeight: 17,
  whiteSpace: 'nowrap',
  fontWeight: 500,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-secondary)',
}

const statusMessage: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const track: CSSProperties = {
  flex: 'none',
  width: 96,
  height: 4,
  borderRadius: 2,
  background: 'var(--dsw-alias-bg-module-platform)',
  overflow: 'hidden',
}

const errorText: CSSProperties = {
  margin: 0,
  padding: '0 0 12px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-error)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

// ---- footer (PluginCard.module.css footer/discard/save) ---------------------

const footer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 0 4px',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

const link: CSSProperties = {
  marginRight: 'auto',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}

const secondaryButton: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const primaryButton: CSSProperties = {
  appearance: 'none',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

const buttonDisabled: CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
}

/** Outline chevron-down matching IconChevronDownOutline14's geometry. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={open ? chevronOpen : chevron}
    >
      <path d="M3 5.5 7 9.5 11 5.5" />
    </svg>
  )
}

/**
 * Render the SDE update card. Like the shipped cards, it renders nothing
 * while its namespace is unavailable (the tab only dispatches served
 * namespaces, so an absent namespace means the host half is not composed).
 * @param props - locale copy, the card snapshot, and its trigger actions.
 * @returns the card.
 */
export function SdeUpdateCard(props: SdeUpdateCardProps) {
  const { t } = props
  const state = props.useSdeCard((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  const [cardHovered, setCardHovered] = useState(false)
  const [url, setUrl] = useState('')
  const [urlFocused, setUrlFocused] = useState(false)
  const [invalid, setInvalid] = useState<string | undefined>(undefined)

  if (!state.available) return null

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
  const cardStyle = cardHovered ? (open ? cardOpenHover : cardHover) : (open ? cardOpen : card)

  return (
    <li
      style={cardStyle}
      onMouseEnter={() => { setCardHovered(true) }}
      onMouseLeave={() => { setCardHovered(false) }}
    >
      <button
        type="button"
        style={header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headText}>
          <span style={name}>{t('title')}</span>
          <span style={description}>{t('description')}</span>
        </span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div style={body}>
          <div style={field}>
            <div style={fieldHead}>
              <label htmlFor="dsh-esi-sde-url" style={fieldLabel}>{t('urlLabel')}</label>
            </div>
            <input
              id="dsh-esi-sde-url"
              type="text"
              style={state.busy || !state.writable ? inputDisabled : urlFocused ? inputFocus : inputBase}
              value={url}
              disabled={state.busy || !state.writable}
              placeholder={t('urlPlaceholder')}
              aria-invalid={invalid !== undefined}
              onChange={(event) => { setUrl(event.target.value) }}
              onFocus={() => { setUrlFocused(true) }}
              onBlur={() => { setUrlFocused(false) }}
            />
            <p style={invalid !== undefined ? invalidTextStyle : hint}>
              {invalid !== undefined ? invalid : t('urlHint')}
            </p>
          </div>

          {status !== undefined && (
            <div style={statusRow}>
              <span style={badge}>
                {phaseKey === undefined ? status.phase : t(phaseKey)}
              </span>
              <p style={statusMessage}>{status.message}</p>
              {status.progress !== undefined && (
                <div
                  style={track}
                  role="progressbar"
                  aria-valuenow={Math.round(status.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
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
            <p style={errorText} role="alert">{status.error.message}</p>
          )}

          <div style={footer}>
            <a
              href="https://developers.eveonline.com/static-data"
              target="_blank"
              rel="noreferrer"
              style={link}
            >
              {t('officialDataLink')}
            </a>
            <button
              type="button"
              style={state.busy ? { ...secondaryButton, ...buttonDisabled } : secondaryButton}
              disabled={state.busy || !state.writable}
              onClick={startRollback}
            >
              {t('rollback')}
            </button>
            <button
              type="button"
              style={state.busy ? { ...primaryButton, ...buttonDisabled } : primaryButton}
              disabled={state.busy || !state.writable}
              onClick={startUpdate}
            >
              {t('update')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
