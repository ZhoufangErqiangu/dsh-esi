/**
 * The SDE-update settings card: a download-URL input, an update button, a
 * rollback button, and a live status area fed by the host through the
 * `dsh-esi` settings namespace. Uses the shared card chrome
 * (card-chrome.ts) so it stays visually identical to the shipped plugin
 * cards.
 */

import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CardFrame, Field, buttonDisabled, inputBase, inputDisabled, inputFocus,
  primaryButton, secondaryButton,
} from './card-chrome.tsx'
import type { SdeCardFace, SdeGuiStatusView } from './sde-card-controller.ts'
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

/** Host error code → dictionary key (fall back to the raw message for unknown codes). */
const ERROR_KEYS: Record<string, SdeCardLocaleKey> = {
  BUSY: 'err.busy',
  NO_ROLLBACK: 'err.noRollback',
  INTERNAL: 'err.internal',
  URL_EMPTY: 'err.urlEmpty',
  URL_TOO_LONG: 'err.urlTooLong',
  URL_CONTROL_CHAR: 'err.urlControlChar',
  URL_MALFORMED: 'err.urlMalformed',
  URL_SCHEME: 'err.urlScheme',
  URL_NO_HOST: 'err.urlNoHost',
  HTTP_ERROR: 'err.httpError',
  HTTP_404: 'err.http404',
  HTTP_403: 'err.http403',
  NETWORK: 'err.network',
  TIMEOUT: 'err.timeout',
  TOO_LARGE: 'err.tooLarge',
  TOO_LARGE_STREAM: 'err.tooLargeStream',
  DOWNLOAD_EMPTY: 'err.downloadEmpty',
  DOWNLOAD_ABORTED: 'err.downloadAborted',
  ZIP_BAD_MAGIC: 'err.zipBadMagic',
  ZIP_CORRUPT: 'err.zipCorrupt',
  ZIP_EMPTY: 'err.zipEmpty',
  ZIP_BOMB: 'err.zipBomb',
  ZIP_BOMB_SIZE: 'err.zipBombSize',
  PATH_EMPTY: 'err.pathEmpty',
  PATH_UNSAFE: 'err.pathUnsafe',
  PATH_TRAVERSAL: 'err.pathTraversal',
  PAYLOAD_NO_MANIFEST: 'err.payloadNoManifest',
  PAYLOAD_JSON_INVALID: 'err.payloadJsonInvalid',
  PAYLOAD_STRUCT_INVALID: 'err.payloadStructInvalid',
  PAYLOAD_NO_BUILD: 'err.payloadNoBuild',
  PAYLOAD_NO_TABLES: 'err.payloadNoTables',
  PAYLOAD_EMPTY_TABLES: 'err.payloadEmptyTables',
  PAYLOAD_MISSING_TABLES: 'err.payloadMissingTables',
  PAYLOAD_MISSING_TABLES_MANY: 'err.payloadMissingTablesMany',
  DISK_FULL: 'err.diskFull',
  DISK_DENIED: 'err.diskDenied',
  DISK_ERROR: 'err.diskError',
}

/** The localized status-line text: keyed (translated) when the host sent a key, raw otherwise. */
function statusLine(t: (key: SdeCardLocaleKey, params?: Record<string, unknown>) => string, status: SdeGuiStatusView): string {
  return status.messageKey !== undefined
    ? t(status.messageKey as SdeCardLocaleKey, status.messageParams)
    : status.message
}

/** The localized error text: code-keyed (translated) when known, raw otherwise. */
function errorLine(t: (key: SdeCardLocaleKey, params?: Record<string, unknown>) => string, error: NonNullable<SdeGuiStatusView['error']>): string {
  const key = ERROR_KEYS[error.code]
  return key !== undefined ? t(key, error.params) : error.message
}

// ---- status area (official badge/hint language) ------------------------------

const badge: CSSProperties = {
  flex: 'none',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  // '17px' explicitly: a numeric 17 would render as the unitless multiplier
  // line-height: 17 (17× the 11px font = 187px), not 17px like the official
  // .badge rule.
  lineHeight: '17px',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-secondary)',
}

const statusRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 0 12px',
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

/**
 * Render the SDE update card. Like the shipped cards, it renders nothing
 * while its namespace is unavailable.
 * @param props - locale copy, the card snapshot, and its trigger actions.
 * @returns the card.
 */
export function SdeUpdateCard(props: SdeUpdateCardProps) {
  const { t } = props
  const state = props.useSdeCard((snapshot) => snapshot)
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
  const busyOrLocked = state.busy || !state.writable

  return (
    <CardFrame
      title={t('title')}
      description={t('description')}
      expandLabel={t('expand')}
      collapseLabel={t('collapse')}
    >
      <Field
        id="dsh-esi-sde-url"
        label={t('urlLabel')}
        hint={t('urlHint')}
        invalidTextValue={invalid}
      >
        <input
          id="dsh-esi-sde-url"
          type="text"
          style={busyOrLocked ? inputDisabled : urlFocused ? inputFocus : inputBase}
          value={url}
          disabled={busyOrLocked}
          placeholder={t('urlPlaceholder')}
          aria-invalid={invalid !== undefined}
          onChange={(event) => { setUrl(event.target.value) }}
          onFocus={() => { setUrlFocused(true) }}
          onBlur={() => { setUrlFocused(false) }}
        />
      </Field>

      {/* Status area: the badge+message row shows progress phases; error phases
          render only the alert line below (the host sends the error as a
          code-keyed payload, translated via ERROR_KEYS). */}
      {status !== undefined && status.phase !== 'error' && (
        <div style={statusRow}>
          <span style={badge}>
            {phaseKey === undefined ? status.phase : t(phaseKey)}
          </span>
          <p style={statusMessage}>{statusLine(t, status)}</p>
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
        <p style={errorText} role="alert">{errorLine(t, status.error)}</p>
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
          style={busyOrLocked ? { ...secondaryButton, ...buttonDisabled } : secondaryButton}
          disabled={busyOrLocked}
          onClick={startRollback}
        >
          {t('rollback')}
        </button>
        <button
          type="button"
          style={busyOrLocked ? { ...primaryButton, ...buttonDisabled } : primaryButton}
          disabled={busyOrLocked}
          onClick={startUpdate}
        >
          {t('update')}
        </button>
      </div>
    </CardFrame>
  )
}
