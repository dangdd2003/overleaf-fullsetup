import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from '@phosphor-icons/react'
import { ToolCallRecord } from '../../agent/agent-messages'
import { cleanStoredResult } from '../../agent/conversation-store'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import DiffView from './diff-view'
import CodeView from './code-view'
import { faviconUrl, hostOf } from '../../agent/web-sources'

export const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

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

/**
 * One web page as a row, the way Claude.ai lists search results: the site's
 * icon, the page title, and the domain on the right, the whole row a link.
 */
function WebPageRow({
  url,
  title,
  hint,
}: {
  url: string
  title?: string
  hint?: string
}) {
  return (
    <a
      className="ai-assist-web-row"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={hint || title || url}
    >
      <SiteIcon url={url} />
      <span className="ai-assist-web-row-title">{title || hostOf(url)}</span>
      <span className="ai-assist-web-row-meta">{hostOf(url)}</span>
    </a>
  )
}

/**
 * The part of a web tool error meant for the user. The server writes it for
 * the model: it names the URL the row already shows, and ends with advice on
 * what to try next.
 */
function webErrorText(error: string, url?: string) {
  let text = error
  if (url) text = text.split(url).join('The page')
  return text.replace(/\s+(Its search snippet|Read another result)[\s\S]*$/, '').trim()
}

function WebToolError({ call, result }: { call: ToolCallRecord; result: any }) {
  const args = (call.args ?? {}) as any
  const url = typeof result?.url === 'string' ? result.url : args.url
  const message = webErrorText(
    typeof result?.error === 'string'
      ? result.error
      : typeof result === 'string'
        ? result
        : 'The request failed.',
    url
  )
  return (
    <div className="ai-assist-web-detail">
      {call.name === 'web_fetch' && typeof url === 'string' && url && (
        <WebPageRow url={url} title={result?.title} />
      )}
      <div className="ai-assist-web-note is-error">{message}</div>
    </div>
  )
}

export const ToolCallDetailView: FC<{ call: ToolCallRecord }> = ({ call }) => {
  const { t } = useTranslation()
  const args = (call.args ?? {}) as any
  const rawResult = cleanStoredResult(call.result)
  const result = rawResult as any
  const openFile = useOpenFileInEditor()

  if (
    (call.name === 'web_search' || call.name === 'web_fetch') &&
    (call.isError || result?.error)
  ) {
    return <WebToolError call={call} result={result} />
  }

  if (call.isError || result?.error) {
    const errorMsg =
      result?.error ||
      (typeof result === 'string' ? result : 'The tool execution failed.')
    return (
      <div className="ai-assist-tool-detail-error">
        <span className="ai-assist-tool-detail-badge error">Error</span>
        <pre className="ai-assist-tool-detail-text">{errorMsg}</pre>
      </div>
    )
  }

  // 1. read_file
  if (call.name === 'read_file') {
    const rawLines = Array.isArray(result?.lines)
      ? result.lines
      : typeof result?.content === 'string'
      ? result.content.split('\n')
      : null

    if (rawLines && rawLines.length > 0) {
      const startLine =
        typeof result?.from === 'number'
          ? result.from
          : typeof args?.from === 'number'
          ? args.from
          : 1
      return (
        <div className="ai-assist-tool-detail-code">
          <CodeView
            lines={rawLines}
            startLine={startLine}
            onLineClick={line => args.path && openFile(args.path, line)}
          />
          {result?.truncated && (
            <div className="ai-assist-tool-detail-note">
              (lines {result.from ?? 1}-{result.to ?? ''} of {result.totalLines ?? ''})
            </div>
          )}
        </div>
      )
    }

    if (args.path) {
      return (
        <div className="ai-assist-tool-detail-code">
          <div className="ai-assist-tool-detail-note">
            File:{' '}
            <span
              role="button"
              tabIndex={0}
              className="ai-assist-file-link"
              onClick={() => openFile(args.path, args.from)}
              onKeyDown={e => e.key === 'Enter' && openFile(args.path, args.from)}
            >
              {args.path}
            </span>{' '}
            {args.from ? `(lines ${args.from}-${args.to ?? ''})` : ''}
          </div>
        </div>
      )
    }
  }

  // 2. edit_file
  if (call.name === 'edit_file') {
    const oldText = args.oldText ?? args.old_text ?? args.old_string ?? ''
    const newText = args.newText ?? args.new_text ?? args.new_string ?? ''
    const startLine =
      (result as any)?.startLine ?? args?.from ?? args?.startLine ?? 1
    const isRejected = result?.status === 'rejected'
    const isCancelled = result?.status === 'stopped'

    if (oldText || newText) {
      return (
        <div className={`ai-assist-tool-detail-diff ${isRejected ? 'is-rejected' : ''} ${isCancelled ? 'is-cancelled' : ''}`}>
          <div className="ai-assist-tool-detail-header">
            <span
              role="button"
              tabIndex={0}
              className="ai-assist-file-link"
              title={t('ai_assist_open_file', {
                path: args.path,
                defaultValue: `Open ${args.path}`,
              })}
              onClick={() => openFile(args.path, startLine)}
              onKeyDown={e => e.key === 'Enter' && openFile(args.path, startLine)}
            >
              {args.path}{startLine ? `:${startLine}` : ''}
            </span>
            {isRejected && (
              <span className="ai-assist-tool-detail-badge rejected">
                {t('ai_assist_rejected_badge', 'Rejected')}
              </span>
            )}
            {isCancelled && (
              <span className="ai-assist-tool-detail-badge cancelled">
                {t('ai_assist_cancelled_badge', 'Cancelled')}
              </span>
            )}
          </div>
          <DiffView
            oldText={oldText}
            newText={newText}
            startLine={startLine}
            onLineClick={line => args.path && openFile(args.path, line)}
          />
          {result?.note && (
            <div className="ai-assist-tool-detail-note ai-assist-tool-detail-rejection">
              <strong>{t('ai_assist_user_reason', 'User note:')}</strong> {result.note}
            </div>
          )}
          {result?.message && (
            <div className="ai-assist-tool-detail-note">{result.message}</div>
          )}
        </div>
      )
    }
  }

  // 3. create_file
  if (call.name === 'create_file') {
    const content = args.content ?? ''
    const isRejected = result?.status === 'rejected'
    const isCancelled = result?.status === 'stopped'
    return (
      <div className={`ai-assist-tool-detail-diff ${isRejected ? 'is-rejected' : ''} ${isCancelled ? 'is-cancelled' : ''}`}>
        <div className="ai-assist-tool-detail-header">
          <span
            role="button"
            tabIndex={0}
            className="ai-assist-file-link"
            title={t('ai_assist_open_file', {
              path: args.path,
              defaultValue: `Open ${args.path}`,
            })}
            onClick={() => openFile(args.path, 1)}
            onKeyDown={e => e.key === 'Enter' && openFile(args.path, 1)}
          >
            {args.path}
          </span>
          {isRejected && (
            <span className="ai-assist-tool-detail-badge rejected">
              {t('ai_assist_rejected_badge', 'Rejected')}
            </span>
          )}
          {isCancelled && (
            <span className="ai-assist-tool-detail-badge cancelled">
              {t('ai_assist_cancelled_badge', 'Cancelled')}
            </span>
          )}
        </div>
        <DiffView
          oldText=""
          newText={content}
          startLine={1}
          onLineClick={line => args.path && openFile(args.path, line)}
        />
        {result?.note && (
          <div className="ai-assist-tool-detail-note ai-assist-tool-detail-rejection">
            <strong>{t('ai_assist_user_reason', 'User note:')}</strong> {result.note}
          </div>
        )}
        {result?.message && (
          <div className="ai-assist-tool-detail-note">{result.message}</div>
        )}
      </div>
    )
  }

  // 4. list_files: clean list of project files with lines/size
  if (call.name === 'list_files') {
    const files: any[] = Array.isArray(result)
      ? result
      : Array.isArray(result?.files)
      ? result.files
      : []

    if (files.length > 0) {
      return (
        <div className="ai-assist-tool-detail-files">
          {files.map((file: any, idx: number) => (
            <div key={idx} className="ai-assist-file-row">
              <span
                role="button"
                tabIndex={0}
                className="ai-assist-file-link"
                onClick={() => openFile(file.path)}
                onKeyDown={e => e.key === 'Enter' && openFile(file.path)}
              >
                {file.path}
              </span>
              <span className="ai-assist-file-meta">
                {file.lines != null
                  ? `${file.lines} lines`
                  : file.size != null
                  ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                  : file.type}
              </span>
            </div>
          ))}
        </div>
      )
    }
  }

  // 5. get_outline: clean section hierarchy with line numbers
  if (call.name === 'get_outline' || call.name === 'outline_project') {
    const sections: any[] = Array.isArray(result?.sections) ? result.sections : []
    const packages: string[] = Array.isArray(result?.packages) ? result.packages : []

    if (sections.length > 0 || packages.length > 0) {
      return (
        <div className="ai-assist-tool-detail-outline">
          {result?.documentClass && (
            <div className="ai-assist-outline-class">
              Document class: <code>{result.documentClass}</code>
            </div>
          )}
          {sections.map((sec: any, idx: number) => (
            <div
              key={idx}
              className="ai-assist-outline-section"
              style={{ paddingLeft: `${Math.max(0, (sec.level ?? 1) - 1) * 12}px` }}
            >
              <span className="ai-assist-outline-line">Line {sec.line}:</span>
              <span
                role="button"
                tabIndex={0}
                className="ai-assist-file-link"
                onClick={() => openFile(sec.path, sec.line)}
                onKeyDown={e => e.key === 'Enter' && openFile(sec.path, sec.line)}
              >
                {sec.title}
              </span>
            </div>
          ))}
          {packages.length > 0 && (
            <div className="ai-assist-outline-packages">
              Packages: {packages.slice(0, 10).join(', ')}
              {packages.length > 10 ? ` +${packages.length - 10} more` : ''}
            </div>
          )}
        </div>
      )
    }
  }

  // 6. compile_project & get_compile_result
  if (
    call.name === 'compile_project' ||
    call.name === 'get_compile_result' ||
    call.name === 'get_compile_log'
  ) {
    const errors = Array.isArray(result?.errors) ? result.errors : []
    const warnings = Array.isArray(result?.warnings) ? result.warnings : []

    if (errors.length > 0 || warnings.length > 0) {
      return (
        <div className="ai-assist-tool-detail-log">
          {errors.map((err: any, idx: number) => (
            <div key={`err-${idx}`} className="ai-assist-log-entry error">
              <span
                role="button"
                tabIndex={0}
                className={err.file ? 'ai-assist-file-link' : 'ai-assist-log-loc'}
                onClick={() => {
                  if (err.file) openFile(err.file, err.line)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && err.file) openFile(err.file, err.line)
                }}
              >
                {err.file ? `${err.file}:${err.line ?? '?'}` : 'Error'}
              </span>
              <span className="ai-assist-log-msg">{err.message}</span>
              {err.excerpt && (
                <pre className="ai-assist-log-excerpt">{err.excerpt}</pre>
              )}
            </div>
          ))}
          {warnings.slice(0, 5).map((warn: any, idx: number) => (
            <div key={`warn-${idx}`} className="ai-assist-log-entry warning">
              <span
                role="button"
                tabIndex={0}
                className={warn.file ? 'ai-assist-file-link' : 'ai-assist-log-loc'}
                onClick={() => {
                  if (warn.file) openFile(warn.file, warn.line)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && warn.file) openFile(warn.file, warn.line)
                }}
              >
                {warn.file ? `${warn.file}:${warn.line ?? '?'}` : 'Warning'}
              </span>
              <span className="ai-assist-log-msg">{warn.message}</span>
            </div>
          ))}
        </div>
      )
    }

    if (result?.status === 'success') {
      return (
        <div className="ai-assist-tool-detail-success">
          ✓ Compiled successfully with 0 errors and 0 warnings.
        </div>
      )
    }

    if (result?.status === 'none') {
      return (
        <div className="ai-assist-tool-detail-note">
          No previous compile log available.
        </div>
      )
    }
  }

  // 7. search_text
  if (call.name === 'search_text' || call.name === 'search_project') {
    const hits = Array.isArray(result?.hits) ? result.hits : []
    if (hits.length > 0) {
      return (
        <div className="ai-assist-tool-detail-search">
          {hits.map((hit: any, idx: number) => {
            if (typeof hit === 'string') {
              return (
                <div key={idx} className="ai-assist-search-hit">
                  {hit}
                </div>
              )
            }
            return (
              <div key={idx} className="ai-assist-search-hit">
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => openFile(hit.path, hit.line)}
                  onKeyDown={e => e.key === 'Enter' && openFile(hit.path, hit.line)}
                >
                  {hit.path}:{hit.line ?? '?'}
                </span>
                <span className="ai-assist-search-text">{hit.text}</span>
              </div>
            )
          })}
        </div>
      )
    }
    return (
      <div className="ai-assist-tool-detail-note">
        No matches found for &quot;{args.query}&quot;.
      </div>
    )
  }

  // 8. get_references
  if ((call.name === 'get_references' || call.name === 'list_references') && result) {
    return (
      <div className="ai-assist-tool-detail-refs">
        {result.summary && (
          <div className="ai-assist-refs-summary">{result.summary}</div>
        )}
        {Array.isArray(result.duplicateLabels) &&
          result.duplicateLabels.length > 0 && (
            <div className="ai-assist-refs-warning">
              Duplicate labels: {result.duplicateLabels.join(', ')}
            </div>
          )}
      </div>
    )
  }

  // 9. web_search: the results as rows, like Claude.ai's search card
  if (call.name === 'web_search' && Array.isArray(result?.results)) {
    return (
      <div className="ai-assist-web-detail">
        {result.relaxed && (
          <div className="ai-assist-web-note">
            {t(
              'ai_assist_web_search_relaxed',
              'Nothing matched the date or news filter, so these are unfiltered results.'
            )}
          </div>
        )}
        {result.results.length === 0 ? (
          <div className="ai-assist-web-note">
            {t('ai_assist_web_search_empty', 'No results.')}
          </div>
        ) : (
          result.results.map((entry: any, idx: number) => (
            <WebPageRow
              key={`${entry.url}-${idx}`}
              url={entry.url}
              title={entry.title}
              hint={
                [entry.title, entry.published].filter(Boolean).join(' · ') ||
                undefined
              }
            />
          ))
        )}
      </div>
    )
  }

  // 10. web_fetch: the page read, and which part of it
  if (call.name === 'web_fetch' && result?.url) {
    const notes: string[] = []
    if (typeof result.find === 'string') {
      const count = result.totalMatches ?? 0
      notes.push(
        count === 0
          ? `No passage mentions "${result.find}"`
          : `${count} passage${count === 1 ? '' : 's'} mention "${result.find}"`
      )
    } else if (result.totalPages > 1) {
      notes.push(`Page ${result.page ?? 1} of ${result.totalPages}`)
    }
    if (result.published) {
      notes.push(`Published ${result.published}`)
    }
    if (result.archived) {
      notes.push(`Read from the Internet Archive copy of ${result.archived}`)
    }
    return (
      <div className="ai-assist-web-detail">
        <WebPageRow url={result.url} title={result.title} />
        {notes.length > 0 && (
          <div className="ai-assist-web-note">{notes.join(' · ')}</div>
        )}
      </div>
    )
  }

  // Unrecognised tool: show the arguments verbatim rather than an empty panel.
  return (
    <pre className="ai-assist-tool-call-raw">
      {JSON.stringify(call.args, null, 2)}
    </pre>
  )
}
