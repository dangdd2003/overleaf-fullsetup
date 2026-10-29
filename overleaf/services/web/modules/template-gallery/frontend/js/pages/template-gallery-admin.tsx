import React, { useEffect, useState, useCallback } from 'react'
import { renderInReactLayout } from '@/react'
import '@/utils/meta'
import '@/utils/webpack-public-path'
import '@/infrastructure/error-reporter'
import '@/i18n'
import '../../stylesheets/template-gallery.scss'

function getCsrfToken(): string {
  if (typeof window !== 'undefined' && (window as any).csrfToken) {
    return (window as any).csrfToken
  }
  const meta = document.querySelector('meta[name="ol-csrfToken"]') as HTMLMetaElement | null
  return meta?.content || ''
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never'
  try {
    const d = new Date(dateStr)
    return isNaN(d.getTime()) ? 'Invalid date' : d.toLocaleString()
  } catch {
    return 'Invalid date'
  }
}

function percent(part: number, total: number): string {
  if (!total || total <= 0) return '0%'
  return `${Math.round((part / total) * 100)}%`
}

function TemplateGalleryAdminApp() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'danger'; text: string } | null>(null)
  const [acting, setActing] = useState<boolean>(false)

  const loadStatus = useCallback(() => {
    setLoading(true)
    fetch('/admin/templates/api/status', { credentials: 'same-origin' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        setStatus(data)
        setError(null)
      })
      .catch(err => setError(err?.message || 'Failed to load status'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const handleAction = async (endpoint: string, body: object = {}) => {
    setActing(true)
    setActionMessage(null)
    try {
      const csrfToken = getCsrfToken()
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
      }
      setActionMessage({ type: 'success', text: 'Action successfully dispatched' })
      loadStatus()
    } catch (err: any) {
      setActionMessage({ type: 'danger', text: err?.message || 'Action failed' })
    } finally {
      setActing(false)
    }
  }

  const mirror = status?.mirror || {}
  const counts = mirror?.counts || {}
  const total = counts.total || status?.crawler?.totalIndexed || 0
  const withDetail = counts.withDetail || 0
  const withPdf = counts.withPdf || 0
  const withThumb = counts.withThumb || 0
  const tagsScraped = counts.tagsScraped || 0

  const scheduler = mirror?.scheduler || {}
  const recentScan = mirror?.recentScan || {}
  const hostLimiter = mirror?.hostLimiter || {}
  const lastCatalogue = mirror?.lastCatalogue || status?.crawler?.lastCatalogue || {}
  const isPaused = Boolean(mirror?.paused || status?.crawler?.paused)

  return (
    <div className="container py-4 template-gallery-admin">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 className="h2 mb-1">Template Gallery Administration</h1>
          <p className="text-muted mb-0">Official Overleaf LaTeX Template Mirror & Crawler Status</p>
        </div>
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={loadStatus}
          disabled={loading || acting}
        >
          {loading ? 'Refreshing...' : 'Refresh Status'}
        </button>
      </div>

      {error && <div className="alert alert-danger mb-4">{error}</div>}
      {actionMessage && (
        <div className={`alert alert-${actionMessage.type} alert-dismissible mb-4`}>
          {actionMessage.text}
          <button
            type="button"
            className="close"
            style={{ background: 'none', border: 'none', float: 'right' }}
            onClick={() => setActionMessage(null)}
          >
            &times;
          </button>
        </div>
      )}

      {/* System Status Overview */}
      {status && (
        <div className="card mb-4">
          <div className="card-header bg-light">
            <h2 className="h5 mb-0">System Health</h2>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="col-md-3">
                <span className="text-muted d-block small">Lifecycle Readiness</span>
                <strong className={status.ready ? 'text-success' : 'text-danger'}>
                  {status.ready ? 'Ready' : 'Not Ready'}
                </strong>
              </div>
              <div className="col-md-3">
                <span className="text-muted d-block small">Storage Mount</span>
                <strong>{status.storage?.mounted ? 'Mounted & Writable' : 'Unmounted'}</strong>
              </div>
              <div className="col-md-3">
                <span className="text-muted d-block small">Validation Sandbox</span>
                <span className="badge badge-info">{status.sandbox?.mode || 'default'}</span>
              </div>
              <div className="col-md-3">
                <span className="text-muted d-block small">Crawler Switch</span>
                <span className={`badge ${isPaused ? 'badge-warning' : 'badge-success'}`}>
                  {isPaused ? 'PAUSED' : 'ACTIVE'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mirror Progress Section */}
      <div className="card mb-4">
        <div className="card-header bg-light d-flex justify-content-between align-items-center">
          <h2 className="h5 mb-0">Mirror Progress</h2>
          <span className="badge badge-secondary">{total.toLocaleString()} total items</span>
        </div>
        <div className="card-body">
          <div className="row text-center mb-4">
            <div className="col-md">
              <div className="p-3 border rounded bg-white">
                <div className="text-muted small text-uppercase">Total Mirrored</div>
                <div className="h3 mb-0 font-weight-bold">{total.toLocaleString()}</div>
                <div className="small text-muted">items catalogued</div>
              </div>
            </div>
            <div className="col-md">
              <div className="p-3 border rounded bg-white">
                <div className="text-muted small text-uppercase">With Detail</div>
                <div className="h3 mb-0 font-weight-bold">{withDetail.toLocaleString()}</div>
                <div className="small text-muted">{percent(withDetail, total)} completed</div>
              </div>
            </div>
            <div className="col-md">
              <div className="p-3 border rounded bg-white">
                <div className="text-muted small text-uppercase">With PDF</div>
                <div className="h3 mb-0 font-weight-bold">{withPdf.toLocaleString()}</div>
                <div className="small text-muted">{percent(withPdf, total)} completed</div>
              </div>
            </div>
            <div className="col-md">
              <div className="p-3 border rounded bg-white">
                <div className="text-muted small text-uppercase">With Thumbnail</div>
                <div className="h3 mb-0 font-weight-bold">{withThumb.toLocaleString()}</div>
                <div className="small text-muted">{percent(withThumb, total)} completed</div>
              </div>
            </div>
            <div className="col-md">
              <div className="p-3 border rounded bg-white">
                <div className="text-muted small text-uppercase">Tags Scraped</div>
                <div className="h3 mb-0 font-weight-bold">{tagsScraped.toLocaleString()}</div>
                <div className="small text-muted">scope metadata</div>
              </div>
            </div>
          </div>

          <h3 className="h6 mb-2">Completion Gauges</h3>
          <div className="mb-3">
            <div className="d-flex justify-content-between small text-muted mb-1">
              <span>Detail Metadata & Abstract</span>
              <span>
                {withDetail.toLocaleString()} / {total.toLocaleString()} ({percent(withDetail, total)})
              </span>
            </div>
            <div className="progress" style={{ height: '8px' }}>
              <div
                className="progress-bar bg-primary"
                style={{ width: percent(withDetail, total) }}
              />
            </div>
          </div>

          <div className="mb-3">
            <div className="d-flex justify-content-between small text-muted mb-1">
              <span>Compiled Preview PDFs</span>
              <span>
                {withPdf.toLocaleString()} / {total.toLocaleString()} ({percent(withPdf, total)})
              </span>
            </div>
            <div className="progress" style={{ height: '8px' }}>
              <div
                className="progress-bar bg-success"
                style={{ width: percent(withPdf, total) }}
              />
            </div>
          </div>

          <div className="mb-2">
            <div className="d-flex justify-content-between small text-muted mb-1">
              <span>Thumbnails & Preview Images</span>
              <span>
                {withThumb.toLocaleString()} / {total.toLocaleString()} ({percent(withThumb, total)})
              </span>
            </div>
            <div className="progress" style={{ height: '8px' }}>
              <div
                className="progress-bar bg-info"
                style={{ width: percent(withThumb, total) }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Scheduler, Recent Scan & Actions Section */}
      <div className="row mb-4">
        <div className="col-lg-6 mb-4 mb-lg-0">
          <div className="card h-100">
            <div className="card-header bg-light">
              <h2 className="h5 mb-0">Scheduler & Recent Scan</h2>
            </div>
            <div className="card-body">
              <table className="table table-sm table-borderless mb-3">
                <tbody>
                  <tr>
                    <th scope="row" style={{ width: '45%' }}>Leadership:</th>
                    <td>
                      <span className={`badge ${scheduler.leader ? 'badge-success' : 'badge-secondary'}`}>
                        {scheduler.leader ? 'Leader Process' : 'Follower'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Current Step:</th>
                    <td>
                      <code>{scheduler.currentStep?.step || 'idle'}</code>
                      {scheduler.currentStep?.at && (
                        <span className="text-muted small ml-1">
                          ({formatDate(scheduler.currentStep.at)})
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Last Recent Head Scan:</th>
                    <td>{formatDate(scheduler.recentHeadAt)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Recent Scan Checkpoint:</th>
                    <td>
                      {recentScan.nextPage ? (
                        <span>
                          Page <strong>{recentScan.nextPage}</strong>
                          {recentScan.finishedAt && (
                            <span className="badge badge-success ml-2">Finished</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted">No checkpoint</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Last Catalogue Pass:</th>
                    <td>
                      <span>{lastCatalogue.status || 'None'}</span>
                      {lastCatalogue.lastSuccessAt && (
                        <span className="text-muted small ml-1">
                          ({formatDate(lastCatalogue.lastSuccessAt)})
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>

              <h3 className="h6 mb-2">Mirror Controls</h3>
              <div className="btn-group btn-group-sm flex-wrap" role="group">
                <button
                  type="button"
                  className="btn btn-outline-primary"
                  onClick={() => handleAction('/admin/templates/api/crawler/sync', { action: 'catalogue' })}
                  disabled={acting || isPaused}
                >
                  Trigger Catalogue Pass
                </button>
                <button
                  type="button"
                  className="btn btn-outline-info"
                  onClick={() => handleAction('/admin/templates/api/crawler/sync', { action: 'recent' })}
                  disabled={acting || isPaused}
                >
                  Scan Recent Head
                </button>
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => handleAction('/admin/templates/api/crawler/sync', { action: 'recent-full' })}
                  disabled={acting || isPaused}
                >
                  Scan Full Recent
                </button>
                {isPaused ? (
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={() => handleAction('/admin/templates/api/crawler/resume')}
                    disabled={acting}
                  >
                    Resume Crawler
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-warning"
                    onClick={() => handleAction('/admin/templates/api/crawler/pause')}
                    disabled={acting}
                  >
                    Pause Crawler
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Upstream Host Politeness & Circuit Breakers */}
        <div className="col-lg-6">
          <div className="card h-100">
            <div className="card-header bg-light">
              <h2 className="h5 mb-0">Upstream Host Limiter</h2>
            </div>
            <div className="card-body">
              <div className="table-responsive">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Host</th>
                      <th>Circuit</th>
                      <th>Queued (Int/Bg)</th>
                      <th>In-Flight</th>
                      <th>Success / Fail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {['overleaf', 's3', 'algolia'].map(hostKey => {
                      const h = hostLimiter[hostKey] || {}
                      const circuit = h.circuit || 'closed'
                      const circuitBadge =
                        circuit === 'closed'
                          ? 'badge-success'
                          : circuit === 'half_open'
                            ? 'badge-warning'
                            : 'badge-danger'
                      const qInt = h.queued?.interactive ?? 0
                      const qBg = h.queued?.background ?? 0
                      const ok = h.totals?.ok ?? 0
                      const failed = h.totals?.failed ?? 0

                      return (
                        <tr key={hostKey}>
                          <td>
                            <strong>{hostKey}</strong>
                            <div className="small text-muted">{h.intervalMs || 1000}ms rate</div>
                          </td>
                          <td>
                            <span className={`badge ${circuitBadge}`}>{circuit}</span>
                          </td>
                          <td>
                            {qInt} / {qBg}
                          </td>
                          <td>{h.busy ? <span className="badge badge-primary">Active</span> : 'Idle'}</td>
                          <td>
                            <span className="text-success">{ok}</span> /{' '}
                            <span className={failed > 0 ? 'text-danger' : 'text-muted'}>{failed}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="small text-muted">
                Politeness: overleaf &le; 1 rps + jitter, s3 &le; 4 rps, algolia &le; 4 rps.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

renderInReactLayout('template-gallery-admin-container', () => <TemplateGalleryAdminApp />)
export default TemplateGalleryAdminApp
