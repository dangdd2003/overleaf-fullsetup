import { useEffect } from 'react'
import classNames from 'classnames'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import MaterialIcon from '@/shared/components/material-icon'
import { usePersistedResize } from '@/shared/hooks/use-resize'
import { useScrolled } from '@/features/project-list/components/sidebar/use-scroll'
import { SidebarLowerSection } from '@/shared/components/sidebar/sidebar-lower-section'
import { MethodBadge } from './endpoint'
import type { TagSection } from './types'

/**
 * Splits the paths of one tag into the segments they all share (shown once
 * above the list) and the remaining suffix of each. Every suffix keeps at
 * least its last segment.
 */
export function splitSharedPrefix(paths: string[]) {
  if (!paths.length) {
    return { prefix: '', suffixes: [] }
  }
  const segments = paths.map(path => path.split('/').filter(Boolean))
  const shortest = Math.min(...segments.map(parts => parts.length))
  let shared = 0
  while (
    shared < shortest - 1 &&
    segments.every(parts => parts[shared] === segments[0][shared])
  ) {
    shared++
  }
  return {
    prefix: segments[0]?.slice(0, shared).join('/') ?? '',
    suffixes: segments.map(parts => parts.slice(shared).join('/')),
  }
}

export default function ApiDocsSidebar({
  sections,
  query,
  onQueryChange,
  matchCount,
  totalCount,
  activeAnchor,
  hasAuth,
  onNavigate,
}: {
  sections: TagSection[]
  query: string
  onQueryChange: (query: string) => void
  matchCount: number
  totalCount: number
  hasAuth: boolean
  activeAnchor?: string | null
  onNavigate?: () => void
}) {
  const filtering = query.trim().length > 0
  const { mousePos, getHandleProps, getTargetProps } = usePersistedResize({
    name: 'api-docs-sidebar',
  })
  const { containerRef, scrolledUp } = useScrolled()

  // Keep the highlighted entry visible while the content scrolls
  useEffect(() => {
    const container = containerRef.current
    const link = activeAnchor
      ? Array.from(
          container?.querySelectorAll<HTMLElement>('a[href^="#"]') ?? []
        ).find(a => a.getAttribute('href') === `#${activeAnchor}`)
      : null
    if (!container || !link) {
      return
    }
    const box = container.getBoundingClientRect()
    const rect = link.getBoundingClientRect()
    if (rect.top < box.top || rect.bottom > box.bottom) {
      container.scrollTop += rect.top - box.top - box.height / 3
    }
  }, [activeAnchor, containerRef])

  return (
    <div
      className="project-list-sidebar-wrapper-react api-docs-sidebar"
      {...getTargetProps({
        style: {
          ...(mousePos?.x && { flexBasis: `${mousePos.x}px` }),
        },
      })}
    >
      <nav aria-label="API reference" className="flex-grow flex-shrink">
        <div className="project-list-sidebar-scroll" ref={containerRef}>
          <div className="api-docs-search">
            <form
              role="search"
              className="project-search"
              onSubmit={event => event.preventDefault()}
            >
              <OLFormControl
                type="search"
                size="sm"
                aria-label="Filter endpoints by path, summary, method or tag"
                placeholder="Filter endpoints"
                value={query}
                onChange={event => onQueryChange(event.target.value)}
                prepend={<MaterialIcon type="search" />}
              />
            </form>
            <p className="api-docs-count" aria-live="polite">
              {filtering
                ? `${matchCount} of ${totalCount} endpoints`
                : `${totalCount} endpoints`}
            </p>
          </div>

          {/* Links close the mobile drawer; navigation itself is the default */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
          <ul
            className="api-docs-nav-list api-docs-nav"
            onClick={event => {
              if ((event.target as HTMLElement).closest('a')) {
                onNavigate?.()
              }
            }}
          >
            {hasAuth && (
              <li>
                <a
                  href="#authentication"
                  className={classNames('api-docs-nav-tag', {
                    'is-active': activeAnchor === 'authentication',
                  })}
                >
                  <MaterialIcon type="key" />
                  Authentication schemes
                </a>
              </li>
            )}
            {sections.map((section, sectionIndex) => (
              <li
                key={section.groupName ?? sectionIndex}
                className="api-docs-nav-group"
              >
                {section.groupName && (
                  <p className="api-docs-nav-group-title">
                    {section.groupName}
                  </p>
                )}
                <ul className="api-docs-nav-list">
                  {section.tags.map(tag => {
                    const { prefix, suffixes } = splitSharedPrefix(
                      tag.endpoints.map(endpoint => endpoint.path)
                    )
                    return (
                      <li key={tag.anchor}>
                        <a
                          href={`#${tag.anchor}`}
                          className="api-docs-nav-tag"
                        >
                          {tag.name}
                        </a>
                        {prefix && (
                          <p className="api-docs-nav-prefix">
                            <NavPath path={`/${prefix}`} />
                          </p>
                        )}
                        <ul className="api-docs-nav-list api-docs-nav-children">
                          {tag.endpoints.map((endpoint, index) => {
                            const label = `${endpoint.method.toUpperCase()} ${endpoint.path}`
                            const summary = endpoint.operation.summary
                            return (
                              <li key={endpoint.id}>
                                <a
                                  href={`#${endpoint.id}`}
                                  title={summary || endpoint.path}
                                  aria-label={
                                    summary ? `${label}: ${summary}` : label
                                  }
                                  className={classNames(
                                    'api-docs-nav-endpoint',
                                    {
                                      'is-active':
                                        activeAnchor === endpoint.id,
                                    }
                                  )}
                                  aria-current={
                                    activeAnchor === endpoint.id
                                      ? 'location'
                                      : undefined
                                  }
                                >
                                  <MethodBadge
                                    method={endpoint.method}
                                    className="api-docs-method-sm"
                                  />
                                  <NavPath
                                    path={`/${suffixes[index]}`}
                                  />
                                </a>
                              </li>
                            )
                          })}
                        </ul>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div
        className={classNames('ds-nav-sidebar-lower', {
          'show-shadow': scrolledUp,
        })}
      >
        <SidebarLowerSection showThemeToggle />
      </div>
      <div
        className="api-docs-resize-handle"
        {...getHandleProps({
          style: {
            position: 'absolute',
            zIndex: 1,
            top: 0,
            right: '-2px',
            height: '100%',
            width: '4px',
          },
        })}
      />
    </div>
  )
}

/** Path with break opportunities after each slash and path params dimmed */
function NavPath({ path }: { path: string }) {
  return (
    <span className="api-docs-nav-path">
      {path
        .split('/')
        .filter(Boolean)
        .map((segment, index) => (
          <span key={index}>
            /<wbr />
            {segment.startsWith('{') ? (
              <span className="api-docs-nav-path-param">{segment}</span>
            ) : (
              segment
            )}
          </span>
        ))}
    </span>
  )
}
