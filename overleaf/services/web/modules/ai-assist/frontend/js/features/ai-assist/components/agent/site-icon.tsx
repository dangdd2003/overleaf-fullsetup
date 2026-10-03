import { useEffect, useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import { faviconUrl } from '../../agent/web-sources'

/**
 * How long after a failed load the icon is asked for again. The server
 * answers 404 at once for a site it knows has no icon, but also for one it
 * could not check yet (the site was slow): those are tried again.
 */
const RETRY_DELAYS_MS = [3000, 12000]

/**
 * The site's own favicon, found by the server (most sites name it only in
 * their home page's HTML) and served from Overleaf's origin, so no
 * third-party icon service learns what the agent looked up. Sites without
 * any icon get a globe.
 */
export function SiteIcon({ url }: { url: string }) {
  const [failures, setFailures] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const base = faviconUrl(url)

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
    return (
      <span className="ai-assist-web-favicon is-fallback" aria-hidden="true">
        <Globe size={12} />
      </span>
    )
  }
  return (
    <img
      key={attempt}
      className="ai-assist-web-favicon"
      src={attempt ? `${base}&retry=${attempt}` : base}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailures(attempt + 1)}
    />
  )
}
