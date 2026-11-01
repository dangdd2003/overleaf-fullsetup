import type { TFunction } from 'i18next'

function documentLocale(): string | undefined {
  return document.documentElement.lang || undefined
}

// Dates are formatted for the page language. A missing or unparsable value
// renders the translated "Never".
export function formatDateTime(iso: string | null, t: TFunction): string {
  if (!iso) {
    return t('template_gallery_admin_never')
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return t('template_gallery_admin_never')
  }
  return new Intl.DateTimeFormat(documentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

// Counts use the page language
export function formatCount(value: number): string {
  return new Intl.NumberFormat(documentLocale()).format(value)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

// A size such as "1.5 GB"
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const number = new Intl.NumberFormat(documentLocale(), {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
  return `${number} ${BYTE_UNITS[unit]}`
}
