import { useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import { faviconUrl } from '../../agent/web-sources'

/**
 * The site's own favicon, found by the server (most sites name it only in
 * their home page's HTML) and served from Overleaf's origin, so no
 * third-party icon service learns what the agent looked up. Sites without
 * any icon get a globe.
 */
export function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  const src = faviconUrl(url)
  if (failed || !src) {
    return (
      <span className="ai-assist-web-favicon is-fallback" aria-hidden="true">
        <Globe size={12} />
      </span>
    )
  }
  return (
    <img
      className="ai-assist-web-favicon"
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
