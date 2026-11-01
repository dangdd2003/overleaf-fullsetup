export const ADMIN_PATH = '/admin/templates'

export const ADMIN_TABS = ['sync', 'templates', 'settings'] as const

export type AdminTab = (typeof ADMIN_TABS)[number]

export const DEFAULT_ADMIN_TAB: AdminTab = 'sync'

export function parseAdminTab(search: string): AdminTab {
  const value = new URLSearchParams(search).get('tab')
  return ADMIN_TABS.find(tab => tab === value) ?? DEFAULT_ADMIN_TAB
}

// Only the tab parameter changes, so any other query parameters are kept
export function adminTabUrl(tab: AdminTab, search: string): string {
  const params = new URLSearchParams(search)
  params.set('tab', tab)
  return `${ADMIN_PATH}?${params.toString()}`
}

export function itemPageUrl(id: string, hash = ''): string {
  return `${ADMIN_PATH}/items/${encodeURIComponent(id)}${hash}`
}
