import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToolCallRecord } from '../../agent/agent-messages'
import { cleanStoredResult } from '../../agent/conversation-store'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import DiffView from './diff-view'
import CodeView from './code-view'
import { MarkdownContent } from './markdown-content'
import { hostOf } from '../../agent/web-sources'
import { SiteIcon } from './site-icon'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'

export { SiteIcon }

/** The file an edit touched, as Claude Code shows it above the diff. */
function DiffFileHeader({
  call,
  line,
  isRejected,
  isCancelled,
}: {
  call: ToolCallRecord
  line: number
  isRejected: boolean
  isCancelled: boolean
}) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  const path: string = (call.args as any)?.path ?? ''

  return (
    <div className="ai-assist-tool-detail-header">
      <span
        role="button"
        tabIndex={0}
        className="ai-assist-tool-detail-path"
        title={t('ai_assist_open_file', {
          path,
          defaultValue: `Open ${path}`,
        })}
        onClick={() => openFile(path, line)}
        onKeyDown={e => e.key === 'Enter' && openFile(path, line)}
      >
        {path}
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
      {path && (
        <CopyToClipboard
          content={path}
          tooltipId={`ai-assist-copy-path-${call.id}`}
          unfilled
        />
      )}
    </div>
  )
}

export const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

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
  return text
    .replace(/\s+(Its search snippet|Read another result)[\s\S]*$/, '')
    .trim()
}

function WebToolError({ call, result }: { call: ToolCallRecord; result: any }) {
  const { t } = useTranslation()
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
      {call.name === 'web_search' && typeof url === 'string' && url && (
        <WebPageRow url={url} title={result?.title} />
      )}
      {call.name === 'web_fetch' && (
        <div className="ai-assist-web-fetch-header">
          {url ? (
            <a
              className="ai-assist-web-fetch-url"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
            >
              {url}
            </a>
          ) : (
            <span className="ai-assist-web-fetch-url is-missing">
              {result?.title || t('ai_assist_web_fetch_no_url', 'Web page')}
            </span>
          )}
        </div>
      )}
      <div className="ai-assist-tool-detail-error">
        <span className="ai-assist-tool-detail-badge error">Error</span>
        <pre className="ai-assist-tool-detail-text">{message}</pre>
      </div>
    </div>
  )
}

/**
 * One compile error or warning, collapsed to its title — location and
 * message on a single line. Clicking the title drops down the log excerpt.
 */
function CompileLogEntry({
  entry,
  level,
  openFile,
}: {
  entry: any
  level: 'error' | 'warning'
  openFile: (path: string, line?: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const hasExcerpt = Boolean(entry.excerpt)

  return (
    <div className={`ai-assist-log-entry ${level}`}>
      <div className="ai-assist-log-title">
        <span
          role="button"
          tabIndex={0}
          className={entry.file ? 'ai-assist-file-link' : 'ai-assist-log-loc'}
          onClick={() => {
            if (entry.file) openFile(entry.file, entry.line)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && entry.file)
              openFile(entry.file, entry.line)
          }}
        >
          {entry.file
            ? `${entry.file}:${entry.line ?? '?'}`
            : level === 'error'
              ? 'Error'
              : 'Warning'}
        </span>
        {hasExcerpt ? (
          <button
            type="button"
            className="ai-assist-log-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(open => !open)}
          >
            <span className="ai-assist-log-msg">{entry.message}</span>
            <svg
              className={`ai-assist-tool-call-chevron ${expanded ? 'is-expanded' : ''}`}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 4 10 8 6 12" />
            </svg>
          </button>
        ) : (
          <span className="ai-assist-log-msg">{entry.message}</span>
        )}
      </div>
      {hasExcerpt && expanded && (
        <pre className="ai-assist-log-excerpt">{entry.excerpt}</pre>
      )}
    </div>
  )
}

const VIA_NOTES: Record<string, string> = {
  browser: 'Read via browser',
  ollama: 'Read via Ollama',
  websearchapi: 'Read via WebSearchAPI.ai',
  tavily: 'Read via Tavily',
  firecrawl: 'Read via Firecrawl',
  firecrawlSelfHosted: 'Read via Firecrawl',
  jina: 'Read via Jina Reader',
  exa: 'Read via Exa',
}

const ARCHIVE_LABELS: Record<string, string> = {
  wayback: 'Internet Archive',
  'archive.today': 'archive.today',
}

/** The notes line under a fetched page: which part, when, and how it was read. */
export function webFetchNotes(result: any): string[] {
  if (!result || typeof result !== 'object') return []
  const notes: string[] = []
  if (result.totalPages > 1) {
    notes.push(`Page ${result.page ?? 1} of ${result.totalPages}`)
  }
  if (result.published) {
    notes.push(`Published ${result.published}`)
  }
  if (result.archived || result.archiveUrl) {
    const archive = ARCHIVE_LABELS[result.via] ?? 'Internet Archive'
    notes.push(
      result.archived
        ? `Read from the ${archive} copy of ${result.archived}`
        : `Read from the ${archive} copy`
    )
  } else if (VIA_NOTES[result.via]) {
    notes.push(VIA_NOTES[result.via])
  }
  if (result.partial) {
    notes.push('Only part of this page could be read')
  }
  return notes
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
              (lines {result.from ?? 1}-{result.to ?? ''} of{' '}
              {result.totalLines ?? ''})
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
              onKeyDown={e =>
                e.key === 'Enter' && openFile(args.path, args.from)
              }
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
        <div
          className={`ai-assist-tool-detail-diff ${isRejected ? 'is-rejected' : ''} ${isCancelled ? 'is-cancelled' : ''}`}
        >
          <DiffFileHeader
            call={call}
            line={startLine}
            isRejected={isRejected}
            isCancelled={isCancelled}
          />
          <DiffView
            oldText={oldText}
            newText={newText}
            startLine={startLine}
            path={args.path}
            onLineClick={line => args.path && openFile(args.path, line)}
          />
          {result?.note && (
            <div className="ai-assist-tool-detail-note ai-assist-tool-detail-rejection">
              <strong>{t('ai_assist_user_reason', 'User note:')}</strong>{' '}
              {result.note}
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
      <div
        className={`ai-assist-tool-detail-diff ${isRejected ? 'is-rejected' : ''} ${isCancelled ? 'is-cancelled' : ''}`}
      >
        <DiffFileHeader
          call={call}
          line={1}
          isRejected={isRejected}
          isCancelled={isCancelled}
        />
        <DiffView
          oldText=""
          newText={content}
          startLine={1}
          path={args.path}
          onLineClick={line => args.path && openFile(args.path, line)}
        />
        {result?.note && (
          <div className="ai-assist-tool-detail-note ai-assist-tool-detail-rejection">
            <strong>{t('ai_assist_user_reason', 'User note:')}</strong>{' '}
            {result.note}
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
            <div key={file.path || idx} className="ai-assist-file-row">
              <span
                role="button"
                tabIndex={0}
                className="ai-assist-file-link"
                onClick={() => openFile(file.path)}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && openFile(file.path)}
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
    const sections: any[] = Array.isArray(result?.sections)
      ? result.sections
      : []
    const packages: string[] = Array.isArray(result?.packages)
      ? result.packages
      : []

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
              key={`${sec.path ?? ''}:${sec.line ?? 0}:${idx}`}
              className="ai-assist-outline-section"
              style={{
                paddingLeft: `${Math.max(0, (sec.level ?? 1) - 1) * 12}px`,
              }}
            >
              <span className="ai-assist-outline-line">Line {sec.line}:</span>
              <span
                role="button"
                tabIndex={0}
                className="ai-assist-file-link"
                onClick={() => openFile(sec.path, sec.line)}
                onKeyDown={e =>
                  (e.key === 'Enter' || e.key === ' ') &&
                  openFile(sec.path, sec.line)
                }
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
            <CompileLogEntry
              key={`err-${err.file ?? ''}:${err.line ?? 0}:${idx}`}
              entry={err}
              level="error"
              openFile={openFile}
            />
          ))}
          {warnings.slice(0, 5).map((warn: any, idx: number) => (
            <CompileLogEntry
              key={`warn-${warn.file ?? ''}:${warn.line ?? 0}:${idx}`}
              entry={warn}
              level="warning"
              openFile={openFile}
            />
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
                  onKeyDown={e =>
                    e.key === 'Enter' && openFile(hit.path, hit.line)
                  }
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
  if (
    (call.name === 'get_references' || call.name === 'list_references') &&
    result
  ) {
    return <ReferencesDetail result={result} openFile={openFile} />
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
  if (call.name === 'web_fetch') {
    const url =
      (typeof result?.url === 'string'
        ? result.url
        : typeof args?.url === 'string'
          ? args.url
          : '') || ''
    const notes = result ? webFetchNotes(result) : []
    const hasMatches =
      Array.isArray(result?.matches) && result.matches.length > 0
    const hasContent =
      typeof result?.content === 'string' && result.content.trim().length > 0
    const hasText =
      typeof result?.text === 'string' && result.text.trim().length > 0
    const outputText = hasContent
      ? result.content
      : hasText
        ? result.text
        : typeof result === 'string'
          ? result
          : null

    return (
      <div className="ai-assist-web-fetch-detail">
        <div className="ai-assist-web-fetch-header">
          {url ? (
            <a
              className="ai-assist-web-fetch-url"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={url}
            >
              {url}
            </a>
          ) : (
            <span className="ai-assist-web-fetch-url is-missing">
              {result?.title || t('ai_assist_web_fetch_no_url', 'Web page')}
            </span>
          )}
          {notes.length > 0 && (
            <span
              className="ai-assist-web-fetch-notes"
              title={notes.join(' · ')}
            >
              · {notes.join(' · ')}
            </span>
          )}
        </div>
        <div className="ai-assist-web-fetch-box">
          {hasMatches ? (
            <div className="ai-assist-web-fetch-content">
              {result.matches.map((match: any, idx: number) => (
                <div key={`${match.heading ?? 'passage'}:${match.page ?? 0}:${idx}`} className="ai-assist-web-fetch-passage">
                  {match.heading && (
                    <div className="ai-assist-web-fetch-heading">
                      {match.heading}
                      {typeof match.page === 'number' && result?.totalPages > 1
                        ? ` (page ${match.page})`
                        : ''}
                    </div>
                  )}
                  <MarkdownContent content={match.text || ''} baseUrl={url} />
                </div>
              ))}
            </div>
          ) : typeof result?.find === 'string' &&
            (result?.totalMatches === 0 || !hasMatches) ? (
            <div className="ai-assist-web-note">
              No passages found mentioning &quot;{result.find}&quot;.
            </div>
          ) : outputText ? (
            <div className="ai-assist-web-fetch-content">
              <MarkdownContent content={String(outputText)} baseUrl={url} />
            </div>
          ) : (
            <div className="ai-assist-web-note">No content available.</div>
          )}
        </div>
      </div>
    )
  }

  // 11. list_available_settings
  if (call.name === 'list_available_settings') {
    const options = result?.options ?? (typeof result === 'object' ? result : null)
    if (options) {
      return <ListAvailableSettingsDetail options={options} />
    }
  }

  // 12. get_project_settings
  if (call.name === 'get_project_settings') {
    const settings = result?.settings ?? (typeof result === 'object' ? result : null)
    if (settings) {
      return <GetProjectSettingsDetail settings={settings} openFile={openFile} />
    }
  }

  // 13. configure settings tools
  if (
    call.name === 'configure_appearance_settings' ||
    call.name === 'configure_editor_settings' ||
    call.name === 'configure_compiler_settings' ||
    call.name === 'configure_project_settings'
  ) {
    return <ConfigureSettingsDetail call={call} result={result} />
  }

  // Generic / fallback tool: show formatted key-values rather than an unstyled pre
  return <GenericToolDetail call={call} result={result} />
}

function ReferencesDetail({
  result,
  openFile,
}: {
  result: any
  openFile: (path: string, line?: number) => void
}) {
  if (!result || typeof result !== 'object') return null
  const labels = Array.isArray(result.labels) ? result.labels : []
  const duplicateLabels = Array.isArray(result.duplicateLabels)
    ? result.duplicateLabels
    : []
  const refs = Array.isArray(result.refs) ? result.refs : []
  const citations = Array.isArray(result.citations) ? result.citations : []
  const bibKeys = Array.isArray(result.bibKeys) ? result.bibKeys : []

  const totalItems =
    labels.length +
    duplicateLabels.length +
    refs.length +
    citations.length +
    bibKeys.length

  if (totalItems === 0) {
    return (
      <div className="ai-assist-tool-detail-note">
        No labels, references, or citations found in project.
      </div>
    )
  }

  return (
    <div className="ai-assist-tool-detail-refs">
      {duplicateLabels.length > 0 && (
        <div className="ai-assist-refs-warning">
          <strong>Duplicate labels:</strong> {duplicateLabels.join(', ')}
        </div>
      )}

      {refs.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Cross-References ({refs.length})
          </div>
          <div className="ai-assist-refs-list">
            {refs.map((r: any, idx: number) => (
              <div
                key={`ref-${idx}`}
                className={`ai-assist-ref-item ${r.resolved ? 'is-resolved' : 'is-unresolved'}`}
              >
                <span className="ai-assist-ref-cmd">
                  \{r.command || 'ref'}&#123;{r.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => r.path && openFile(r.path, r.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && r.path && openFile(r.path, r.line)
                  }
                >
                  {r.path}:{r.line ?? '?'}
                </span>
                <span
                  className={`ai-assist-ref-badge ${r.resolved ? 'resolved' : 'unresolved'}`}
                >
                  {r.resolved ? '✓ OK' : '✗ Unresolved'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {citations.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Citations ({citations.length})
          </div>
          <div className="ai-assist-refs-list">
            {citations.map((c: any, idx: number) => (
              <div
                key={`cite-${idx}`}
                className={`ai-assist-ref-item ${c.resolved ? 'is-resolved' : 'is-unresolved'}`}
              >
                <span className="ai-assist-ref-cmd">
                  \{c.command || 'cite'}&#123;{c.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => c.path && openFile(c.path, c.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && c.path && openFile(c.path, c.line)
                  }
                >
                  {c.path}:{c.line ?? '?'}
                </span>
                <span
                  className={`ai-assist-ref-badge ${c.resolved ? 'resolved' : 'unresolved'}`}
                >
                  {c.resolved ? '✓ OK' : '✗ Missing'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {labels.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Labels ({labels.length})
          </div>
          <div className="ai-assist-refs-list">
            {labels.slice(0, 30).map((l: any, idx: number) => (
              <div key={`lbl-${idx}`} className="ai-assist-ref-item">
                <span className="ai-assist-ref-cmd">
                  \label&#123;{l.key}&#125;
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => l.path && openFile(l.path, l.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && l.path && openFile(l.path, l.line)
                  }
                >
                  {l.path}:{l.line ?? '?'}
                </span>
              </div>
            ))}
            {labels.length > 30 && (
              <div className="ai-assist-tool-detail-note">
                +{labels.length - 30} more labels
              </div>
            )}
          </div>
        </div>
      )}

      {bibKeys.length > 0 && (
        <div className="ai-assist-refs-section">
          <div className="ai-assist-refs-section-title">
            Bibliography Entries ({bibKeys.length})
          </div>
          <div className="ai-assist-refs-list">
            {bibKeys.slice(0, 30).map((b: any, idx: number) => (
              <div key={`bib-${idx}`} className="ai-assist-ref-item">
                <span className="ai-assist-ref-cmd">@{b.key}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => b.path && openFile(b.path, b.line)}
                  onKeyDown={e =>
                    e.key === 'Enter' && b.path && openFile(b.path, b.line)
                  }
                >
                  {b.path}:{b.line ?? '?'}
                </span>
              </div>
            ))}
            {bibKeys.length > 30 && (
              <div className="ai-assist-tool-detail-note">
                +{bibKeys.length - 30} more entries
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const SETTING_LABELS: Record<string, string> = {
  overallTheme: 'Overall Theme',
  editorTheme: 'Editor Theme',
  editorLightTheme: 'Editor Light Theme',
  editorDarkTheme: 'Editor Dark Theme',
  darkModePdf: 'Dark Mode PDF',
  fontSize: 'Font Size',
  fontFamily: 'Font Family',
  lineHeight: 'Line Spacing',
  compiler: 'Compiler Engine',
  imageName: 'TeX Live Version',
  rootDocPath: 'Root Document',
  rootDocId: 'Root Doc ID',
  draft: 'Draft Mode',
  stopOnFirstError: 'Stop on Error',
  mode: 'Keybinding Mode',
  autoComplete: 'Auto-complete',
  autoPairDelimiters: 'Auto-close Brackets',
  syntaxValidation: 'Syntax Validation',
  pdfViewer: 'PDF Viewer',
  mathPreview: 'Math Preview',
  breadcrumbs: 'Breadcrumbs Bar',
  editorTabs: 'Editor Tabs',
  spellCheckLanguage: 'Spell-check Language',
}

function ListAvailableSettingsDetail({ options }: { options: any }) {
  if (!options || typeof options !== 'object') return null
  const compilers: string[] = options.compilers || []
  const imageNames: any[] = options.imageNames || []
  const overallThemes: string[] = options.overallThemes || []
  const editorThemes: string[] = Array.isArray(options.editorThemes)
    ? options.editorThemes.map((t: any) =>
        typeof t === 'string' ? t : t.name
      )
    : []
  const fontFamilies: any[] = options.fontFamilies || []
  const editorModes: string[] = options.editorModes || []
  const lineHeights: string[] = options.lineHeights || []
  const spellCheckLanguages: any[] = options.spellCheckLanguages || []
  const pdfViewers: string[] = options.pdfViewers || ['pdfjs', 'native']

  return (
    <div className="ai-assist-settings-detail">
      {compilers.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            LaTeX Compilers
          </span>
          <div className="ai-assist-settings-chips">
            {compilers.map(c => (
              <span key={c} className="ai-assist-settings-chip">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {imageNames.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            TeX Live Versions
          </span>
          <div className="ai-assist-settings-chips">
            {imageNames.map((img: any) => (
              <span
                key={img.imageName || img}
                className="ai-assist-settings-chip"
                title={img.imageDesc}
              >
                {img.imageDesc || img.imageName || img}
              </span>
            ))}
          </div>
        </div>
      )}

      {editorThemes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Editor Syntax Themes
          </span>
          <div className="ai-assist-settings-chips">
            {editorThemes.map(theme => (
              <span key={theme} className="ai-assist-settings-chip">
                {theme}
              </span>
            ))}
          </div>
        </div>
      )}

      {overallThemes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Overall Themes</span>
          <div className="ai-assist-settings-chips">
            {overallThemes.map(t => (
              <span key={t} className="ai-assist-settings-chip">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {editorModes.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Keybinding Modes
          </span>
          <div className="ai-assist-settings-chips">
            {editorModes.map(m => (
              <span key={m} className="ai-assist-settings-chip">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {fontFamilies.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Code Fonts</span>
          <div className="ai-assist-settings-chips">
            {fontFamilies.map((f: any) => (
              <span
                key={f.name || f}
                className="ai-assist-settings-chip"
                title={f.label}
              >
                {f.label ? `${f.name} (${f.label})` : f.name || f}
              </span>
            ))}
          </div>
        </div>
      )}

      {lineHeights.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Line Spacing</span>
          <div className="ai-assist-settings-chips">
            {lineHeights.map(lh => (
              <span key={lh} className="ai-assist-settings-chip">
                {lh}
              </span>
            ))}
          </div>
        </div>
      )}

      {spellCheckLanguages.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Spellcheck Languages
          </span>
          <div className="ai-assist-settings-chips">
            {spellCheckLanguages.slice(0, 14).map((lang: any) => (
              <span
                key={lang.code || lang}
                className="ai-assist-settings-chip"
              >
                {lang.name
                  ? `${lang.name} (${lang.code})`
                  : lang.code || lang}
              </span>
            ))}
            {spellCheckLanguages.length > 14 && (
              <span className="ai-assist-settings-chip-more">
                +{spellCheckLanguages.length - 14} more
              </span>
            )}
          </div>
        </div>
      )}

      {pdfViewers.length > 0 && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">PDF Viewer</span>
          <div className="ai-assist-settings-chips">
            {pdfViewers.map(v => (
              <span key={v} className="ai-assist-settings-chip">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function GetProjectSettingsDetail({
  settings,
  openFile,
}: {
  settings: any
  openFile: (path: string) => void
}) {
  if (!settings || typeof settings !== 'object') return null
  const { compiler, appearance, editor, spelling, name, description } =
    settings

  return (
    <div className="ai-assist-settings-detail">
      {name && (
        <div className="ai-assist-settings-section-header">
          <strong>Project:</strong> {name}
          {description ? ` — ${description}` : ''}
        </div>
      )}

      {compiler && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Compiler</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Compiler:</span>
              <span className="ai-assist-settings-val">
                {compiler.compiler || 'pdflatex'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">TeX Live:</span>
              <span className="ai-assist-settings-val">
                {compiler.imageName || 'default'}
              </span>
            </div>
            {compiler.rootDocPath && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Root Doc:</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="ai-assist-file-link"
                  onClick={() => openFile(compiler.rootDocPath)}
                  onKeyDown={e =>
                    e.key === 'Enter' && openFile(compiler.rootDocPath)
                  }
                >
                  {compiler.rootDocPath}
                </span>
              </div>
            )}
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Draft Mode:</span>
              <span className="ai-assist-settings-val">
                {compiler.draft ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Stop on Error:</span>
              <span className="ai-assist-settings-val">
                {compiler.stopOnFirstError ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}

      {appearance && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Appearance</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Overall Theme:</span>
              <span className="ai-assist-settings-val">
                {appearance.overallTheme || 'system'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Editor Theme:</span>
              <span className="ai-assist-settings-val">
                {appearance.editorTheme || 'textmate'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Font Size:</span>
              <span className="ai-assist-settings-val">
                {appearance.fontSize ?? 12}px
              </span>
            </div>
            {appearance.fontFamily && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Font Family:</span>
                <span className="ai-assist-settings-val">
                  {appearance.fontFamily}
                </span>
              </div>
            )}
            {appearance.lineHeight && (
              <div className="ai-assist-settings-row">
                <span className="ai-assist-settings-key">Line Spacing:</span>
                <span className="ai-assist-settings-val">
                  {appearance.lineHeight}
                </span>
              </div>
            )}
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Dark Mode PDF:</span>
              <span className="ai-assist-settings-val">
                {appearance.darkModePdf ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">
            Editor Behavior
          </span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Keybindings:</span>
              <span className="ai-assist-settings-val">
                {editor.mode || 'none'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Auto-complete:</span>
              <span className="ai-assist-settings-val">
                {editor.autoComplete ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                Auto-close Brackets:
              </span>
              <span className="ai-assist-settings-val">
                {editor.autoPairDelimiters ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                Syntax Validation:
              </span>
              <span className="ai-assist-settings-val">
                {editor.syntaxValidation ? 'On' : 'Off'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">PDF Viewer:</span>
              <span className="ai-assist-settings-val">
                {editor.pdfViewer || 'pdfjs'}
              </span>
            </div>
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Math Preview:</span>
              <span className="ai-assist-settings-val">
                {editor.mathPreview ? 'On' : 'Off'}
              </span>
            </div>
          </div>
        </div>
      )}

      {spelling?.spellCheckLanguage && (
        <div className="ai-assist-settings-group">
          <span className="ai-assist-settings-group-label">Spelling</span>
          <div className="ai-assist-settings-rows">
            <div className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">Language:</span>
              <span className="ai-assist-settings-val">
                {spelling.spellCheckLanguage}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ConfigureSettingsDetail({
  call,
  result,
}: {
  call: ToolCallRecord
  result: any
}) {
  const args = (call.args ?? {}) as Record<string, any>
  const updated = (result?.updatedSettings ?? args) as Record<string, any>
  const keys = Object.keys(updated).filter(
    k => k !== 'status' && k !== 'message'
  )
  const message = result?.message || 'Settings updated successfully.'

  const formatValue = (key: string, val: any) => {
    if (typeof val === 'boolean') return val ? 'Enabled' : 'Disabled'
    if (key === 'fontSize' && typeof val === 'number') return `${val}px`
    return String(val ?? '')
  }

  return (
    <div className="ai-assist-settings-detail">
      <div className="ai-assist-tool-detail-success">✓ {message}</div>
      {keys.length > 0 && (
        <div className="ai-assist-settings-rows">
          {keys.map(key => (
            <div key={key} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">
                {SETTING_LABELS[key] || key}:
              </span>
              <span className="ai-assist-settings-val">
                {formatValue(key, updated[key])}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GenericToolDetail({
  call,
  result,
}: {
  call: ToolCallRecord
  result: any
}) {
  const hasArgs = call.args && Object.keys(call.args).length > 0
  const hasResult =
    result && typeof result === 'object' && Object.keys(result).length > 0

  if (!hasArgs && !hasResult) {
    if (typeof result === 'string' && result.trim()) {
      return <div className="ai-assist-tool-detail-text">{result}</div>
    }
    return (
      <div className="ai-assist-tool-detail-note">
        No additional parameters.
      </div>
    )
  }

  return (
    <div className="ai-assist-tool-detail-generic">
      {hasArgs && (
        <div className="ai-assist-settings-rows">
          {Object.entries(call.args).map(([k, v]) => (
            <div key={`arg-${k}`} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{k}:</span>
              <span className="ai-assist-settings-val">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
      {hasResult && !hasArgs && (
        <div className="ai-assist-settings-rows">
          {Object.entries(result).map(([k, v]) => (
            <div key={`res-${k}`} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{k}:</span>
              <span className="ai-assist-settings-val">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
