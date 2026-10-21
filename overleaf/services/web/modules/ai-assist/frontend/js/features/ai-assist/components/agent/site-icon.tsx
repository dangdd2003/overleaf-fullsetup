import { ReactNode, useEffect, useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import { faviconUrl } from '../../agent/web-sources'

/**
 * How long after a failed load the icon is asked for again. The server
 * answers 404 at once for a site it knows has no icon, but also for one it
 * could not check yet (the site was slow): those are tried again.
 */
const RETRY_DELAYS_MS = [3000, 12000]

/**
 * The icon route for a connector, which the server answers with the MCP
 * server's own icon or else the favicon of its URL. Null when the connector
 * has no id or no URL, so the caller shows its fallback instead.
 */
export function connectorIconUrl(connector: {
  id?: string
  url?: string | null
}): string | null {
  if (!connector.id || !connector.url) return null
  return `/ai-assist/connectors/${encodeURIComponent(connector.id)}/icon`
}

/**
 * The site's own favicon, found by the server (most sites name it only in
 * their home page's HTML) and served from Overleaf's origin, so no
 * third-party icon service learns what the agent looked up. Sites without
 * any icon get a globe. A `src` replaces the favicon lookup for the URL,
 * and `null` means there is nothing to load.
 */
export function SiteIcon({
  url,
  src,
  fallback,
  className,
}: {
  url: string
  src?: string | null
  fallback?: ReactNode
  className?: string
}) {
  const [failures, setFailures] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const base = src === undefined ? faviconUrl(url) : src
  const classes = ['ai-assist-web-favicon', className].filter(Boolean).join(' ')

  useEffect(() => {
    setFailures(0)
    setAttempt(0)
  }, [base])

  useEffect(() => {
    if (failures === 0 || failures > RETRY_DELAYS_MS.length) return
    const timer = window.setTimeout(
      () => setAttempt(failures),
      RETRY_DELAYS_MS[failures - 1]
    )
    return () => window.clearTimeout(timer)
  }, [failures])

  if (!base || failures > attempt) {
    if (fallback !== undefined) {
      return <>{fallback}</>
    }
    return (
      <span className={`${classes} is-fallback`} aria-hidden="true">
        <Globe size={12} />
      </span>
    )
  }
  // The retry marker joins the icon's own query string, if it has one
  const separator = base.includes('?') ? '&' : '?'
  return (
    <img
      key={attempt}
      className={classes}
      src={attempt ? `${base}${separator}retry=${attempt}` : base}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailures(attempt + 1)}
    />
  )
}
