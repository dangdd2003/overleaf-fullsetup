import { hostOf, safeHttpHref } from '../../agent/web-sources'
import { SiteIcon } from './site-icon'

/**
 * One page in a list of web results: site icon, title, host. Shared by the
 * built-in web_search card and connector results that list pages.
 */
export function WebPageRow({
  url,
  title,
  hint,
}: {
  url: string
  title?: string
  hint?: string
}) {
  const href = safeHttpHref(url)
  const body = (
    <>
      <SiteIcon url={url} />
      <span className="ai-assist-web-row-title">{title || hostOf(url)}</span>
      <span className="ai-assist-web-row-meta">{hostOf(url)}</span>
    </>
  )
  // The URL came from a model or a web page: a non-http(s) one is never a link
  if (!href) {
    return (
      <span className="ai-assist-web-row" title={hint || title || url}>
        {body}
      </span>
    )
  }
  return (
    <a
      className="ai-assist-web-row"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={hint || title || url}
    >
      {body}
    </a>
  )
}
