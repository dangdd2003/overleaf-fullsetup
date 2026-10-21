import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import MaterialIcon from '@/shared/components/material-icon'
import OLCard from '@/shared/components/ol/ol-card'
import Description from './description'
import { CodeBlock } from './code-sample'
import type { OpenApiSpec, TagSection } from './types'
import { authHeaderLines, schemeTitle, slugify } from './spec-utils'

export function ApiDocsIntro({
  spec,
  origin,
}: {
  spec: OpenApiSpec
  origin: string
}) {
  return (
    <header className="api-docs-intro">
      <span className="api-docs-eyebrow">
        <MaterialIcon type="api" />
        REST API · {spec.info.version}
      </span>
      <h1 className="api-docs-title">{spec.info.title}</h1>
      <Description text={spec.info.description} className="api-docs-lead" />
      <div className="api-docs-base-url">
        <span className="api-docs-base-url-label">Base URL</span>
        <code>{origin}</code>
        <CopyToClipboard
          content={origin}
          tooltipId="api-docs-base-url-copy"
          kind="icon"
        />
      </div>
    </header>
  )
}

const GROUP_ICONS: Record<string, string> = {
  Authentication: 'key',
  'MCP REST API': 'hub',
  'Git Bridge': 'commit',
  Service: 'monitor_heart',
}

function OverviewCard({
  href,
  icon,
  name,
  meta,
}: {
  href: string
  icon: string
  name: string
  meta: string
}) {
  return (
    <OLCard className="api-docs-overview-card">
      <a href={href} className="api-docs-overview-link stretched-link">
        <MaterialIcon type={icon} className="api-docs-overview-icon" />
        <span className="api-docs-overview-name">{name}</span>
        <span className="api-docs-overview-meta">{meta}</span>
      </a>
    </OLCard>
  )
}

/** One card per x-tagGroups section, linking to its first tag */
export function ApiDocsOverview({
  sections,
  hasAuth,
  schemeCount,
}: {
  sections: TagSection[]
  hasAuth: boolean
  schemeCount: number
}) {
  const cards = sections.filter((section) => section.tags.length > 0)
  if (cards.length < 2) {
    return null
  }
  return (
    <nav aria-label="API overview" className="api-docs-overview">
      {hasAuth && (
        <OverviewCard
          href="#authentication"
          icon="lock"
          name="Getting access"
          meta={`${schemeCount} authentication ${
            schemeCount === 1 ? 'scheme' : 'schemes'
          }`}
        />
      )}
      {cards.map((section) => {
        const count = section.tags.reduce(
          (total, tag) => total + tag.endpoints.length,
          0
        )
        const name = section.groupName ?? 'Endpoints'
        return (
          <OverviewCard
            key={name}
            href={`#${section.tags[0].anchor}`}
            icon={GROUP_ICONS[name] || 'data_object'}
            name={name}
            meta={`${count} ${count === 1 ? 'endpoint' : 'endpoints'} · ${section.tags
              .map(tag => tag.name)
              .join(', ')}`}
          />
        )
      })}
    </nav>
  )
}

export function AuthenticationSection({ spec }: { spec: OpenApiSpec }) {
  const schemes = Object.entries(spec.components?.securitySchemes || {})
  if (!schemes.length) {
    return null
  }
  return (
    <section id="authentication" className="api-docs-section">
      <header className="api-docs-tag-header">
        <h2 className="api-docs-tag-title">Authentication</h2>
        <p className="api-docs-tag-description">
          Requests are authenticated with one of the schemes below. Each
          endpoint lists the scheme it accepts.
        </p>
      </header>
      <div className="api-docs-schemes">
        {schemes.map(([name, scheme]) => (
          <div key={name} id={`auth-${slugify(name)}`}>
            <OLCard className="api-docs-scheme">
              <h3 className="api-docs-scheme-title">
                {schemeTitle(scheme)}
                <code className="api-docs-scheme-name">{name}</code>
              </h3>
              <Description text={scheme.description} />
              <CodeBlock
                label="Headers"
                code={authHeaderLines(name, scheme).join('\n')}
              />
              {scheme.type === 'oauth2' && scheme.flows && (
                <ul className="api-docs-flows">
                  {Object.entries(scheme.flows).map(([flow, config]) => (
                    <li key={flow}>
                      <code>{flow}</code>
                      {config.tokenUrl && (
                        <>
                          {' '}
                          token URL: <code>{config.tokenUrl}</code>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </OLCard>
          </div>
        ))}
      </div>
    </section>
  )
}
