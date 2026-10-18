import {
  authorizeConnector,
  listConnectors,
  notifyConnectorsChanged,
} from './api'
import { ConnectorOAuthMessage } from './types'
import { safeHttpHref } from '../agent/web-sources'

export const OAUTH_CHANNEL = 'ai-assist-connectors'
export const OAUTH_STORAGE_KEY = 'ai-assist:connector-oauth'
const POLL_MS = 2000
const BACKGROUND_POLL_MS = 5000
const CLOSED_CHECK_MS = 500
// After the window looks closed, how long a late callback still has to land
const CLOSED_GRACE_MS = 1500
const GIVE_UP_MS = 10 * 60 * 1000
const POPUP_WIDTH = 520
const POPUP_HEIGHT = 720

/**
 * Window features that put the popup in the middle of the user's window,
 * kept inside the usable screen area so a partly off-screen browser window
 * does not put the popup off-screen.
 */
export function centeredPopupFeatures(
  width = POPUP_WIDTH,
  height = POPUP_HEIGHT
) {
  const screen = window.screen as Screen & {
    availLeft?: number
    availTop?: number
  }
  const outerLeft = window.screenX ?? window.screenLeft ?? 0
  const outerTop = window.screenY ?? window.screenTop ?? 0
  const outerWidth = window.outerWidth || screen?.availWidth || width
  const outerHeight = window.outerHeight || screen?.availHeight || height
  const availLeft = screen?.availLeft ?? 0
  const availTop = screen?.availTop ?? 0
  const availWidth = screen?.availWidth || width
  const availHeight = screen?.availHeight || height
  const w = Math.min(width, availWidth)
  const h = Math.min(height, availHeight)
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max)
  const left = clamp(
    Math.round(outerLeft + (outerWidth - w) / 2),
    availLeft,
    availLeft + availWidth - w
  )
  const top = clamp(
    Math.round(outerTop + (outerHeight - h) / 2),
    availTop,
    availTop + availHeight - h
  )
  return `popup,width=${w},height=${h},left=${left},top=${top}`
}

export type OAuthOutcome =
  | { status: 'connected' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' }

function isOAuthMessage(
  value: unknown,
  connectorId: string
): value is ConnectorOAuthMessage {
  const message = value as ConnectorOAuthMessage | null
  return (
    message?.type === 'ai-assist:connector-oauth' &&
    message.connectorId === connectorId
  )
}

/** Background watches left behind by attempts the user gave up on, by connector id. */
const backgroundWatches = new Map<string, () => void>()

/** Ends any background watch still running for the connector. */
function stopBackgroundWatch(connectorId: string) {
  backgroundWatches.get(connectorId)?.()
}

/** Ends every background watch, e.g. on test teardown. */
export function stopBackgroundWatches() {
  for (const stop of [...backgroundWatches.values()]) stop()
}

/**
 * Listens for the callback page's report, over the BroadcastChannel, the
 * storage event and window messages. Returns the function that removes them.
 */
function listenForCallback(
  connectorId: string,
  onCallback: (outcome: OAuthOutcome) => void
): () => void {
  const fromMessage = (data: unknown) => {
    if (!isOAuthMessage(data, connectorId)) return
    onCallback(
      data.status === 'connected'
        ? { status: 'connected' }
        : {
            status: 'error',
            error: data.error || 'Authorization with the MCP server failed',
          }
    )
  }

  const onWindowMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return
    fromMessage(event.data)
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== OAUTH_STORAGE_KEY || !event.newValue) return
    try {
      fromMessage(JSON.parse(event.newValue))
    } catch {}
  }

  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(OAUTH_CHANNEL)
    channel.onmessage = event => fromMessage(event.data)
  }
  window.addEventListener('message', onWindowMessage)
  window.addEventListener('storage', onStorage)

  return () => {
    channel?.close()
    window.removeEventListener('message', onWindowMessage)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * After the popup was seen closed but the sign-in had not completed, keeps
 * listening for a late callback or a connected status. When the sign-in
 * completes, every view is told to refresh. Ends at the give-up time.
 */
function startBackgroundWatch(connectorId: string, startedAt: number) {
  stopBackgroundWatch(connectorId)

  let stopped = false
  let detach = () => {}
  let pollTimer: number | null = null
  let giveUpTimer: number | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    detach()
    if (pollTimer) window.clearInterval(pollTimer)
    if (giveUpTimer) window.clearTimeout(giveUpTimer)
    if (backgroundWatches.get(connectorId) === stop) {
      backgroundWatches.delete(connectorId)
    }
  }

  const onConnected = () => {
    stop()
    notifyConnectorsChanged()
  }

  detach = listenForCallback(connectorId, outcome => {
    if (outcome.status === 'connected') onConnected()
    else stop()
  })

  pollTimer = window.setInterval(() => {
    listConnectors()
      .then(({ connectors }) => {
        if (stopped) return
        if (connectors.find(c => c.id === connectorId)?.status === 'connected') {
          onConnected()
        }
      })
      .catch(() => {})
  }, BACKGROUND_POLL_MS)
  giveUpTimer = window.setTimeout(
    stop,
    Math.max(0, GIVE_UP_MS - (Date.now() - startedAt))
  )

  backgroundWatches.set(connectorId, stop)
}

/**
 * Signs a connector in through its authorization server in a popup.
 *
 * Call it straight from a click handler: the window is opened before the
 * authorize request so popup blockers let it through. An authorization
 * server that sends Cross-Origin-Opener-Policy cuts the popup off from this
 * page, so `window.opener` and `popup.closed` cannot be trusted; the callback
 * page reports back over a BroadcastChannel and localStorage instead, and the
 * connector's status is polled as a last resort.
 *
 * A closed popup resolves 'cancelled' after a short grace, but the sign-in may
 * still be running behind a COOP-cut popup. In that case the attempt keeps
 * watching in the background and calls notifyConnectorsChanged() once the
 * connector is connected.
 */
export function connectWithPopup(
  connectorId: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<OAuthOutcome> {
  // A new attempt replaces any background watch an earlier one left running
  stopBackgroundWatch(connectorId)
  const startedAt = Date.now()
  const popup = window.open(
    '',
    `ai-assist-connector-${connectorId}`,
    centeredPopupFeatures()
  )
  // The authorization server is another site and gets navigated in this
  // window: it must not hold a handle back to this page (reverse tabnabbing).
  // The callback page reports over the BroadcastChannel and storage instead.
  if (popup) {
    try {
      popup.opener = null
    } catch {}
  }

  return new Promise<OAuthOutcome>(resolve => {
    let settled = false
    let detach = () => {}
    let pollTimer: number | null = null
    let closedTimer: number | null = null
    let graceTimer: number | null = null
    let giveUpTimer: number | null = null

    const finish = (
      outcome: OAuthOutcome,
      { watchInBackground = false }: { watchInBackground?: boolean } = {}
    ) => {
      if (settled) return
      settled = true
      detach()
      signal?.removeEventListener('abort', onAbort)
      if (pollTimer) window.clearInterval(pollTimer)
      if (closedTimer) window.clearInterval(closedTimer)
      if (graceTimer) window.clearTimeout(graceTimer)
      if (giveUpTimer) window.clearTimeout(giveUpTimer)
      if (outcome.status !== 'connected' && popup && !popup.closed) {
        try {
          popup.close()
        } catch {}
      }
      if (watchInBackground) startBackgroundWatch(connectorId, startedAt)
      resolve(outcome)
    }

    const onAbort = () => finish({ status: 'cancelled' })

    detach = listenForCallback(connectorId, outcome => finish(outcome))
    signal?.addEventListener('abort', onAbort)

    authorizeConnector(connectorId)
      .then(({ authorizationUrl }) => {
        if (settled) return
        // The URL comes from the connector's discovered metadata; only plain
        // http(s) may ever be navigated to.
        const href = safeHttpHref(authorizationUrl)
        if (!href) {
          finish({
            status: 'error',
            error: 'The MCP server returned an invalid authorization URL',
          })
          return
        }
        if (!popup) {
          // Never navigate the current tab: that would drop unsaved edits.
          finish({
            status: 'error',
            error:
              'The sign-in window was blocked. Allow pop-ups for this site and click Sign in again.',
          })
          return
        }
        // The user closed the window while the authorize request was out
        if (popup.closed) {
          finish({ status: 'cancelled' })
          return
        }
        popup.location.href = href
        pollTimer = window.setInterval(() => {
          listConnectors()
            .then(({ connectors }) => {
              if (settled) return
              const connector = connectors.find(c => c.id === connectorId)
              if (connector?.status === 'connected') {
                finish({ status: 'connected' })
              }
            })
            .catch(() => {})
        }, POLL_MS)
        // A closed window ends the wait, after one last look in case the
        // sign-in finished as it closed. A server whose opener policy cuts
        // the window off also reads as closed; the sign-in may still finish,
        // so the background watch keeps listening after the attempt resolves.
        closedTimer = window.setInterval(() => {
          if (settled || !popup?.closed) return
          if (closedTimer) window.clearInterval(closedTimer)
          closedTimer = null
          graceTimer = window.setTimeout(() => {
            graceTimer = null
            if (settled) return
            listConnectors()
              .then(({ connectors }) => {
                if (settled) return
                const connector = connectors.find(c => c.id === connectorId)
                if (connector?.status === 'connected') {
                  finish({ status: 'connected' })
                } else {
                  finish({ status: 'cancelled' }, { watchInBackground: true })
                }
              })
              .catch(() =>
                finish({ status: 'cancelled' }, { watchInBackground: true })
              )
          }, CLOSED_GRACE_MS)
        }, CLOSED_CHECK_MS)
        giveUpTimer = window.setTimeout(
          () => finish({ status: 'cancelled' }),
          GIVE_UP_MS
        )
      })
      .catch(error => {
        finish({
          status: 'error',
          error:
            error?.data?.error ||
            error?.message ||
            'Authorization with the MCP server failed',
        })
      })
  })
}
