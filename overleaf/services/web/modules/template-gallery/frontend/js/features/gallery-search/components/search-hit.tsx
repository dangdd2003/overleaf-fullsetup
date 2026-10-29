import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'
import OLBadge from '@/shared/components/ol/ol-badge'
import BadgeLinkWithTooltip from '@/shared/components/badge/badge-link-with-tooltip'
import type { GallerySearchHit } from '../types'

function SearchHighlight({ snippetHtml }: { snippetHtml: string }) {
  // The server escapes the description and only adds <strong> highlights;
  // sanitising again keeps the markup limited to that.
  const html = useMemo(
    () => DOMPurify.sanitize(snippetHtml, { ALLOWED_TAGS: ['strong'] }),
    [snippetHtml]
  )
  return (
    <p className="search-highlight" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

function SearchHit({ hit }: { hit: GallerySearchHit }) {
  const { t } = useTranslation()

  return (
    <div className="search-hit">
      <div className="search-image">
        <a href={hit.href}>
          <img src={hit.thumbUrl} alt={hit.title} />
        </a>
      </div>
      <div>
        <div className="search-title">
          <a href={hit.href}>
            <b>{hit.title}</b>
          </a>
          {hit.official && (
            <OLBadge
              className="gallery-official"
              id={`gallery-hit-${hit.token}`}
              bg="info"
            >
              {t('official')}
            </OLBadge>
          )}
        </div>
        <div>
          <SearchHighlight snippetHtml={hit.snippetHtml} />
          {hit.author && <strong className="search-author">{hit.author}</strong>}
          {hit.tags && (
            <ul className="search-hit-tags badge-link-list">
              {hit.tags.map(tag => (
                <li key={`tag-${tag.name}`}>
                  <BadgeLinkWithTooltip
                    bg="light"
                    text="dark"
                    href={tag.href}
                    tooltipTitle={tag.title}
                  >
                    {tag.title}
                  </BadgeLinkWithTooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export default SearchHit
