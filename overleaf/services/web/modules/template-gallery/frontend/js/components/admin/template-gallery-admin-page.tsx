import { useCallback, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import OLCard from '@/shared/components/ol/ol-card'
import type { SyncFilter } from '../../api/types'
import { FlashNotification, type Flash } from '../shared/flash'
import { NestedSectionContext } from '../shared/section-card'
import ItemsTab from './items-tab'
import MonitorTab from './monitor-tab'
import SettingsTab from './settings-tab'
import {
  ADMIN_TABS,
  adminTabUrl,
  parseAdminTab,
  type AdminTab,
} from './tab-urls'

const TAB_LABEL_KEYS: Record<AdminTab, string> = {
  sync: 'template_gallery_admin_tab_sync',
  templates: 'template_gallery_admin_tab_templates',
  settings: 'template_gallery_admin_tab_settings',
}

function tabId(tab: AdminTab) {
  return `template-gallery-admin-tab-${tab}`
}

function panelId(tab: AdminTab) {
  return `template-gallery-admin-panel-${tab}`
}

export default function TemplateGalleryAdminPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AdminTab>(() =>
    parseAdminTab(window.location.search)
  )
  const [flash, setFlash] = useState<Flash | null>(null)
  // Filter the Templates tab opens with, e.g. after clicking a count
  const [templatesFilter, setTemplatesFilter] = useState<SyncFilter>('all')

  const selectTab = useCallback((next: AdminTab) => {
    setTab(next)
    setFlash(null)
    if (next !== 'templates') setTemplatesFilter('all')
    window.history.replaceState(
      window.history.state,
      '',
      adminTabUrl(next, window.location.search)
    )
  }, [])

  // Arrow keys, Home and End move between tabs, as the WAI-ARIA tabs pattern asks
  function handleTabKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const current = ADMIN_TABS.indexOf(tab)
    let next: number | null = null
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % ADMIN_TABS.length
        break
      case 'ArrowLeft':
        next = (current - 1 + ADMIN_TABS.length) % ADMIN_TABS.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = ADMIN_TABS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = ADMIN_TABS[next]
    selectTab(target)
    document.getElementById(tabId(target))?.focus()
  }

  function renderPanel() {
    switch (tab) {
      case 'sync':
        return (
          <MonitorTab
            onFlash={setFlash}
            onShowTemplates={state => {
              setTemplatesFilter(state)
              selectTab('templates')
            }}
          />
        )
      case 'templates':
        return (
          <ItemsTab
            key={templatesFilter}
            initialSync={templatesFilter}
            onFlash={setFlash}
          />
        )
      case 'settings':
        return <SettingsTab onFlash={setFlash} />
    }
  }

  return (
    <div className="row">
      <div className="col-12">
        <OLCard>
          <div className="page-header">
            <h1>{t('template_gallery_admin_title')}</h1>
          </div>

          {flash ? (
            <FlashNotification flash={flash} onDismiss={() => setFlash(null)} />
          ) : null}

          <div className="ol-tabs">
            <div className="nav-tabs-container">
              <ul
                className="nav nav-tabs align-left"
                role="tablist"
                aria-label={t('template_gallery_admin_title')}
                onKeyDown={handleTabKeyDown}
              >
                {ADMIN_TABS.map(item => (
                  <li key={item} role="presentation">
                    <button
                      type="button"
                      role="tab"
                      id={tabId(item)}
                      aria-controls={panelId(item)}
                      aria-selected={tab === item}
                      tabIndex={tab === item ? 0 : -1}
                      className={`nav-link ${tab === item ? 'active' : ''}`}
                      onClick={() => selectTab(item)}
                    >
                      {t(TAB_LABEL_KEYS[item])}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="tab-content">
              <div
                className="tab-pane active"
                role="tabpanel"
                id={panelId(tab)}
                aria-labelledby={tabId(tab)}
                tabIndex={0}
              >
                <p className="text-muted mb-4">
                  {t('template_gallery_admin_subtitle')}
                </p>
                <NestedSectionContext.Provider value>
                  {renderPanel()}
                </NestedSectionContext.Provider>
              </div>
            </div>
          </div>
        </OLCard>
      </div>
    </div>
  )
}
