/**
 * Shared card chrome for the dsh-esi settings cards, mirroring the shipped
 * plugin cards (PluginCard.tsx / fields.tsx in ui-settings-plugins): the
 * container (border-l2 / bg-layer-3, 12px radius, hover + open variants),
 * the disclosure header (name over description, rotating outline chevron),
 * the labelled field treatment, and the footer buttons. Self-contained
 * inline styles over the theme variables — the client bundle cannot import
 * the ui-settings-plugins package (bundle purity gate).
 */

import { useState, type CSSProperties } from 'react'
type ReactNode = React.ReactNode

// ---- card container + header -------------------------------------------------

export const card: CSSProperties = {
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

export const cardOpen: CSSProperties = {
  ...card,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

export const cardHover: CSSProperties = {
  ...card,
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

export const header: CSSProperties = {
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

export const headText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

export const nameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}

export const descriptionStyle: CSSProperties = {
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

/** Outline chevron-down matching IconChevronDownOutline14's geometry. */
export function ChevronIcon({ open }: { open: boolean }) {
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

export const body: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingBottom: 8,
}

// ---- field treatment ----------------------------------------------------------

export const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
}

/** A field separated from the previous one by the official hairline. */
export const fieldSeparated: CSSProperties = {
  ...field,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

export const fieldHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

export const fieldLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

export const inputBase: CSSProperties = {
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

export const inputFocus: CSSProperties = {
  ...inputBase,
  borderColor: 'var(--dsw-alias-brand-primary)',
}

export const inputDisabled: CSSProperties = {
  ...inputBase,
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'default',
}

export const hint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

export const invalidText: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-error)',
}

/** A labelled field block: label row, the control, and a hint/invalid line. */
export function Field(props: {
  id: string
  label: string
  hint?: string
  invalidTextValue?: string
  children: ReactNode
}) {
  return (
    <div style={field}>
      <div style={fieldHead}>
        <label htmlFor={props.id} style={fieldLabel}>{props.label}</label>
      </div>
      {props.children}
      <p style={props.invalidTextValue !== undefined ? invalidText : hint}>
        {props.invalidTextValue ?? props.hint ?? ''}
      </p>
    </div>
  )
}

// ---- buttons -------------------------------------------------------------------

export const secondaryButton: CSSProperties = {
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

export const primaryButton: CSSProperties = {
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

export const buttonDisabled: CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
}

// ---- the card frame -------------------------------------------------------------

export interface CardFrameProps {
  /** Card title (header name line). */
  title: string
  /** Header description line. */
  description: string
  /** Expand/collapse aria copy. */
  expandLabel: string
  collapseLabel: string
  /** The card body, rendered when open. */
  children: ReactNode
}

/**
 * One settings card's chrome: container with hover/open variants, the
 * disclosure header (name over description + rotating chevron), and the
 * body. Mirrors PluginCard.tsx's structure; disclosure state is internal.
 */
export function CardFrame(props: CardFrameProps) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const style = hovered ? cardHover : (open ? cardOpen : card)
  return (
    <li
      style={style}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
    >
      <button
        type="button"
        style={header}
        aria-expanded={open}
        aria-label={`${props[open ? 'collapseLabel' : 'expandLabel']}: ${props.title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headText}>
          <span style={nameStyle}>{props.title}</span>
          <span style={descriptionStyle}>{props.description}</span>
        </span>
        <ChevronIcon open={open} />
      </button>
      {open ? <div style={body}>{props.children}</div> : null}
    </li>
  )
}
