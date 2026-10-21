import {
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import classNames from 'classnames'
import { getJSON } from '@/infrastructure/fetch-json'
import { useTranslation } from 'react-i18next'
import LoadingBranded from '@/shared/components/loading-branded'
import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import MaterialIcon from '@/shared/components/material-icon'
import DefaultNavbar from '@/shared/components/navbar/default-navbar'
import Footer from '@/shared/components/footer/footer'
import CookieBanner from '@/shared/components/cookie-banner'
import SystemMessages from '@/shared/components/system-messages'
import overleafLogo from '@/shared/svgs/overleaf-a-ds-solution-mallard.svg'
import overleafLogoDark from '@/shared/svgs/overleaf-a-ds-solution-mallard-dark.svg'
import { useActiveOverallTheme } from '@/shared/hooks/use-active-overall-theme'
import getMeta from '@/utils/meta'
import useWaitForI18n from '@/shared/hooks/use-wait-for-i18n'
import useThemedPage from '@/shared/hooks/use-themed-page'
import { SplitTestProvider } from '@/shared/context/split-test-context'
import { UserSettingsProvider } from '@/shared/context/user-settings-context'
import '../../stylesheets/api-docs.scss'
import ApiDocsSidebar from './api-docs/sidebar'
import {
  ApiDocsIntro,
  ApiDocsOverview,
  AuthenticationSection,
} from './api-docs/intro'
import EndpointSection from './api-docs/endpoint'
import Description from './api-docs/description'
import type { OpenApiSpec } from './api-docs/types'
import {
  buildSections,
  listEndpoints,
  matchesQuery,
} from './api-docs/spec-utils'

function scrollToHash() {
  let id = ''
  try {
    id = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return
  }
  if (id) {
    document.getElementById(id)?.scrollIntoView()
  }
}

/**
 * Id of the anchored block nearest the top of the reading area, so the sidebar
 * can highlight where the reader is. The reading area is the scroll container
 * of the page, which sits below the site navbar.
 */
function useActiveAnchor(ids: string[], scrollRef: RefObject<HTMLElement>) {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const root = scrollRef.current
    if (!ids.length || !root) {
      return
    }
    // A block linked from the sidebar stays active while it is on screen,
    // even when the one above it still reaches the top (short endpoints, or
    // the end of the page where the target can't scroll up to the top)
    let linked: string | null = null

    const update = () => {
      const rootRect = root.getBoundingClientRect()
      // Just below the scroll-margin-top that anchors land at
      const line = rootRect.top + 48
      let current: string | null = null
      for (const id of ids) {
        const element = document.getElementById(id)
        if (!element) {
          continue
        }
        if (element.getBoundingClientRect().top <= line) {
          current = id
        } else {
          break
        }
      }
      if (linked) {
        const rect = document.getElementById(linked)?.getBoundingClientRect()
        if (rect && rect.bottom > rootRect.top && rect.top < rootRect.bottom) {
          current = linked
        } else {
          linked = null
        }
      }
      setActive(current ?? ids[0])
    }

    const onHashChange = () => {
      let id = ''
      try {
        id = decodeURIComponent(window.location.hash.slice(1))
      } catch {}
      if (ids.includes(id)) {
        linked = id
        setActive(id)
      }
    }

    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }

    onHashChange()
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('hashchange', onHashChange)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', onScroll)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [ids, scrollRef])

  return active
}

/** Floating button that returns the reading area to the top */
function BackToTop({ scrollRef }: { scrollRef: RefObject<HTMLElement> }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const root = scrollRef.current
    if (!root) {
      return
    }
    const onScroll = () => setVisible(root.scrollTop > root.clientHeight)
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [scrollRef])

  if (!visible) {
    return null
  }

  return (
    <OLTooltip
      id="api-docs-back-to-top"
      description="Back to top"
      overlayProps={{ placement: 'left' }}
    >
      <OLIconButton
        variant="secondary"
        size="lg"
        icon="arrow_upward"
        accessibilityLabel="Back to top"
        className="api-docs-back-to-top"
        onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      />
    </OLTooltip>
  )
}

export default function ApiDocsPageRoot() {
  const { isReady } = useWaitForI18n()
  if (!isReady) {
    return null
  }
  return (
    <SplitTestProvider>
      <UserSettingsProvider>
        <ApiDocsPage />
      </UserSettingsProvider>
    </SplitTestProvider>
  )
}

function ApiDocsPage() {
  useThemedPage()
  const { t } = useTranslation()
  const navbarProps = getMeta('ol-navbar')
  const footerProps = getMeta('ol-footer')
  const activeOverallTheme = useActiveOverallTheme()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [spec, setSpec] = useState<OpenApiSpec | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const origin = window.location.origin

  useEffect(() => {
    let active = true
    getJSON<OpenApiSpec>('/api/v0/openapi.json')
      .then(data => {
        if (active) {
          setSpec(data)
        }
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const endpoints = useMemo(() => (spec ? listEndpoints(spec) : []), [spec])
  const matching = useMemo(
    () => endpoints.filter(endpoint => matchesQuery(endpoint, query)),
    [endpoints, query]
  )
  const sections = useMemo(
    () => (spec ? buildSections(spec, matching) : []),
    [spec, matching]
  )
  const anchorIds = useMemo(
    () => [
      'authentication',
      ...sections.flatMap(section =>
        section.tags.flatMap(tag => tag.endpoints.map(endpoint => endpoint.id))
      ),
    ],
    [sections]
  )
  const activeAnchor = useActiveAnchor(anchorIds, scrollRef)

  // The page renders after the browser has tried the fragment, so scroll again
  useEffect(() => {
    if (spec) {
      scrollToHash()
    }
  }, [spec])

  const schemeCount = Object.keys(spec?.components?.securitySchemes || {}).length
  const hasAuth = schemeCount > 0

  let body: ReactNode
  if (loadFailed) {
    body = (
      <div className="api-docs-state">
        <Notification
          type="error"
          content="The API reference could not be loaded. Try reloading the page."
        />
      </div>
    )
  } else if (spec) {
    body = (
      <>
        <ApiDocsIntro spec={spec} origin={origin} />
        {!query.trim() && (
          <ApiDocsOverview
            sections={sections}
            hasAuth={hasAuth}
            schemeCount={schemeCount}
          />
        )}
        {hasAuth && <AuthenticationSection spec={spec} />}

        {sections.length === 0 && (
          <div className="api-docs-empty">
            <MaterialIcon type="search_off" />
            <p className="api-docs-empty-text">
              No endpoints match &ldquo;{query.trim()}&rdquo;.
            </p>
            <OLButton
              variant="secondary"
              size="sm"
              onClick={() => setQuery('')}
            >
              Clear filter
            </OLButton>
          </div>
        )}

        {sections.map(section => (
          <div key={section.groupName ?? 'all'} className="api-docs-group">
            {section.groupName && (
              <p className="api-docs-group-title">{section.groupName}</p>
            )}
            {section.tags.map(tag => (
              <section key={tag.anchor} id={tag.anchor} className="api-docs-tag">
                <header className="api-docs-tag-header">
                  <h2 className="api-docs-tag-title">{tag.name}</h2>
                  <Description
                    text={tag.description}
                    className="api-docs-tag-description"
                  />
                </header>
                {tag.endpoints.map(endpoint => (
                  <EndpointSection
                    key={endpoint.id}
                    spec={spec}
                    endpoint={endpoint}
                    origin={origin}
                  />
                ))}
              </section>
            ))}
          </div>
        ))}
      </>
    )
  }

  // Same branded loading screen as the editor
  if (!spec && !loadFailed) {
    return (
      <div className="loading-screen api-docs-loading-screen">
        <LoadingBranded loadProgress={20} label={t('loading')} />
      </div>
    )
  }

  return (
    <div
      className={classNames(
        'project-ds-nav-page',
        'website-redesign',
        'api-docs-page',
        { 'is-nav-open': navOpen }
      )}
    >
      <SystemMessages />
      <DefaultNavbar
        {...navbarProps}
        customLogo={
          activeOverallTheme === 'dark'
            ? navbarProps.customLogoDark
            : navbarProps.customLogo
        }
        overleafLogo={
          activeOverallTheme === 'dark' ? overleafLogoDark : overleafLogo
        }
        showCloseIcon
      />
      <div className="project-list-wrapper">
        {spec && (
          <ApiDocsSidebar
            sections={sections}
            query={query}
            onQueryChange={setQuery}
            matchCount={matching.length}
            totalCount={endpoints.length}
            hasAuth={hasAuth}
            activeAnchor={activeAnchor}
            onNavigate={() => setNavOpen(false)}
          />
        )}
        <div className="project-ds-nav-content-and-messages">
          <div className="project-ds-nav-content" ref={scrollRef}>
            {spec && <BackToTop scrollRef={scrollRef} />}
            {spec && (
              <button
                type="button"
                className="api-docs-nav-toggle"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(open => !open)}
              >
                <MaterialIcon type={navOpen ? 'close' : 'menu'} />
                Browse endpoints
              </button>
            )}
            <main id="main-content" tabIndex={-1} className="api-docs api-docs-main">
              {body}
            </main>
            <Footer {...footerProps} />
          </div>
          <CookieBanner />
        </div>
      </div>
    </div>
  )
}
