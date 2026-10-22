import getMeta from '@/utils/meta'

declare global {
  interface Window {
    csrfToken?: string
  }
}

export function getCsrfHeaders(): Record<string, string> {
  const token =
    (typeof window !== 'undefined' && window.csrfToken) ||
    getMeta('ol-csrfToken') ||
    ''
  return token ? { 'X-Csrf-Token': token } : {}
}

export const csrfHeaders = getCsrfHeaders
