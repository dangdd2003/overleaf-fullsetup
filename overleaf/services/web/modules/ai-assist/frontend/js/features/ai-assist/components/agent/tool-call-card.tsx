import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Files,
  FileText,
  MagnifyingGlass,
  TreeStructure,
  Package,
  Bookmarks,
  PencilSimple,
  FilePlus,
  Play,
  TerminalWindow,
  Gear,
  SlidersHorizontal,
  ListChecks,
  Wrench,
  Globe,
  Article,
  FilePdf,
  SquaresFour,
  FileMagnifyingGlass,
  PlugsConnected,
  Crosshair,
  GitDiff,
  Highlighter,
  TextAa,
} from '@phosphor-icons/react'
import { ToolCallRecord } from '../../agent/agent-messages'
import { wantsCleanCompile } from '../../agent/tools/compile-args'
import { diffStatsForCall } from './diff-stats'
import { DiffStatBadge } from './diff-stat-badge'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import { SiteIcon } from './site-icon'
import {
  ToolCallDetailView,
  badBoxesLabel,
  overviewFindings,
} from './tool-call-detail'
import { hostOf } from '../../agent/web-sources'
import {
  humanizeServer,
  isConnectorToolName,
  isMcpToolName,
  mcpArgSummary,
  mcpServerSegment,
  READ_CONNECTOR_RESULT,
  SEARCH_CONNECTOR_TOOLS,
} from '../../agent/mcp-tool-output'
import { useMcpConnector } from '../../agent/mcp-connector-names'
import {
  subresultExpansionStore,
  toolCallSignature,
} from './subresult-expansion-store'
import type { TranslateFn } from './pdf-tool-shared'

export function getToolIcon(name: string, size = 13) {
  switch (name) {
    case 'list_files':
    case 'project_map':
      return <Files size={size} />
    case 'read_file':
      return <FileText size={size} />
    case 'search_text':
    case 'search_project':
      return <MagnifyingGlass size={size} />
    case 'get_outline':
      return <TreeStructure size={size} />
    case 'get_packages':
      return <Package size={size} />
    case 'get_references':
    case 'list_references':
      return <Bookmarks size={size} />
    case 'edit_file':
      return <PencilSimple size={size} />
    case 'create_file':
      return <FilePlus size={size} />
    case 'compile_project':
      return <Play size={size} />
    case 'get_compile_result':
    case 'get_compile_log':
      return <TerminalWindow size={size} />
    case 'view_compiled_pdf_page':
      return <FilePdf size={size} />
    case 'view_compiled_pdf_overview':
      return <SquaresFour size={size} />
    case 'search_compiled_pdf':
      return <FileMagnifyingGlass size={size} />
    case 'resolve_pdf_block':
      return <Crosshair size={size} />
    case 'diff_compiled_pdf':
      return <GitDiff size={size} />
    case 'inspect_compiled_style':
      return <TextAa size={size} />
    case 'highlight_in_pdf':
      return <Highlighter size={size} />
    case 'get_project_settings':
    case 'configure_project_settings':
    case 'configure_compiler_settings':
      return <Gear size={size} />
    case 'get_editor_settings':
    case 'configure_editor_settings':
    case 'configure_appearance_settings':
      return <SlidersHorizontal size={size} />
    case 'list_available_settings':
    case 'present_plan':
      return <ListChecks size={size} />
    case 'web_search':
      return <Globe size={size} />
    case 'web_fetch':
    case 'read_connector_result':
      return <Article size={size} />
    case 'search_connector_tools':
      return <PlugsConnected size={size} />
    default:
      if (name.startsWith('mcp__')) {
        return <PlugsConnected size={size} />
      }
      return <Wrench size={size} />
  }
}

type ToolSummary = {
  action: string
  target?: string
  isFile?: boolean
  fileLine?: number
  lineRange?: string
  /** Quiet trailing detail, like a result count. */
  meta?: string
  /** A compile's error and warning counts, each coloured when non-zero. */
  compileCounts?: { errors: number; warnings: number }
}

function formatLineRanges(args: any, result: any): string | null {
  if (!args && !result) return null

  if (Array.isArray(args?.ranges) && args.ranges.length > 0) {
    return args.ranges.map((r: any) => `${r.from}-${r.to}`).join(', ')
  }
  if (Array.isArray(args?.lines) && args.lines.length > 0) {
    return args.lines
      .map((r: any) => (Array.isArray(r) ? `${r[0]}-${r[1]}` : String(r)))
      .join(', ')
  }

  if (args?.from != null && args?.to != null) {
    return `${args.from}-${args.to}`
  }
  if (args?.range?.from != null && args?.range?.to != null) {
    return `${args.range.from}-${args.range.to}`
  }
  if (args?.from != null && result?.to != null) {
    return `${args.from}-${result.to}`
  }

  if (result?.from != null && result?.to != null) {
    return `${result.from}-${result.to}`
  }

  if (result?.totalLines != null && result.totalLines > 0) {
    return `1-${result.totalLines}`
  }

  return null
}

/** "14-25" for the lines an applied edit landed on. */
function appliedLineRange(result: any): string | undefined {
  const from = result?.startLine
  const to = result?.endLine
  if (typeof from !== 'number' || from <= 0) return undefined
  return typeof to === 'number' && to > from ? `${from}-${to}` : String(from)
}

const PDF_TOOLS = new Set([
  'view_compiled_pdf_page',
  'view_compiled_pdf_overview',
  'search_compiled_pdf',
])

const firstNumber = (...values: unknown[]) =>
  values.find((value): value is number => typeof value === 'number')

/** `main.tex:40-52`, or `main.tex:40` for a single line */
function pdfSourceSpan(path: unknown, from: unknown, to: unknown) {
  if (typeof path !== 'string' || typeof from !== 'number') return undefined
  return typeof to === 'number' && to > from
    ? `${path}:${from}-${to}`
    : `${path}:${from}`
}

/** `3 / 6 (top) · main.tex:40-52`: the page and its zoomed source */
function pdfPageTarget(args: any, result: any) {
  const page = typeof result?.page === 'number' ? result.page : args?.page
  if (page == null) return undefined
  const source = result?.focus
    ? pdfSourceSpan(result.focus.path, result.focus.line, result.focus.endLine)
    : args?.endLine != null
      ? pdfSourceSpan(args.path, args.line, args.endLine)
      : undefined
  // A zoom's region is the focus itself, which the source already says
  const regionName = result?.region ?? args?.region
  const region =
    !source && regionName && regionName !== 'full' && regionName !== 'focus'
      ? ` (${regionName})`
      : ''
  return [
    `${page}${result?.pageCount ? ` / ${result.pageCount}` : ''}${region}`,
    source,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** `pages 1–12 / 34`, from the result when it has the range */
function pdfOverviewTarget(args: any, result: any, t: TranslateFn) {
  const from = firstNumber(result?.fromPage, args.fromPage)
  if (from == null) return undefined
  const to = firstNumber(result?.toPage, args.toPage) ?? from
  const range = t('ai_assist_tool_pdf_pages', {
    count: to - from + 1,
    defaultValue: from === to ? `page ${from}` : `pages ${from}–${to}`,
  })
  return result?.pageCount ? `${range} / ${result.pageCount}` : range
}

/** The query in quotes */
function pdfQueryTarget(args: any, result: any) {
  const query = typeof result?.query === 'string' ? result.query : args.query
  return typeof query === 'string' && query ? `"${query}"` : undefined
}

/** How many pages the overview flags, when any do */
function pdfOverviewMeta(result: any, t: TranslateFn) {
  const pages: any[] = Array.isArray(result?.pages) ? result.pages : []
  const flagged = pages.filter(
    page => overviewFindings(page, t).length > 0
  ).length
  return flagged > 0
    ? t('ai_assist_tool_pdf_pages_flagged', {
        count: flagged,
        defaultValue: `${flagged} page${flagged === 1 ? '' : 's'} flagged`,
      })
    : undefined
}

function pdfSearchMeta(result: any, t: TranslateFn) {
  const count =
    typeof result?.matchCount === 'number'
      ? result.matchCount
      : Array.isArray(result?.matches)
        ? result.matches.length
        : undefined
  if (count == null) return undefined
  return count > 0
    ? t('ai_assist_tool_pdf_matches', {
        count,
        defaultValue: `${count} match${count === 1 ? '' : 'es'}`,
      })
    : t('ai_assist_tool_pdf_no_matches', 'no matches')
}

/** While a PDF tool runs, its target is whatever its arguments ask for */
function pdfPendingTarget(name: string, args: any, t: TranslateFn) {
  switch (name) {
    case 'view_compiled_pdf_page':
      return pdfPageTarget(args, undefined)
    case 'view_compiled_pdf_overview':
      return pdfOverviewTarget(args, undefined, t)
    case 'search_compiled_pdf':
      return pdfQueryTarget(args, undefined)
    default:
      return undefined
  }
}

export function summarise(
  call: ToolCallRecord,
  t: (key: string, opts?: any) => string
): ToolSummary {
  const summary = summariseCall(call, t)
  if (!call || typeof call !== 'object') return summary

  // A connector's call names its server, and says what it was about
  if (isMcpToolName(call.name)) {
    return {
      ...summary,
      target: humanizeServer(mcpServerSegment(call.name)) || undefined,
      meta: summary.meta ?? mcpArgSummary(call.args),
    }
  }
  if (call.name === READ_CONNECTOR_RESULT) {
    const args = (call.args ?? {}) as any
    return {
      ...summary,
      target:
        args.id != null
          ? `${args.id}${args.page != null ? ` · page ${args.page}` : ''}`
          : undefined,
    }
  }
  if (call.name === SEARCH_CONNECTOR_TOOLS) {
    const query = (call.args as any)?.query
    return {
      ...summary,
      target:
        typeof query === 'string' && query.trim()
          ? query.replace(/^select:/, '').trim()
          : undefined,
    }
  }
  return summary
}

function summariseCall(
  call: ToolCallRecord,
  t: (key: string, opts?: any) => string
): ToolSummary {
  if (!call || typeof call !== 'object') {
    return { action: '' }
  }
  const args = (call.args ?? {}) as any
  const result = call.result as any

  const getToolBaseAction = () => {
    switch (call.name) {
      case 'get_references':
      case 'list_references':
        return t('ai_assist_tool_list_references', 'Checked references')
      case 'get_outline':
        return t('ai_assist_tool_get_outline', 'Outlined project')
      case 'get_packages':
        return t('ai_assist_tool_get_packages', 'Checked packages')
      case 'list_files':
        return t('ai_assist_tool_list_files', 'Listed files')
      case 'read_file':
        return t('ai_assist_tool_read_file', 'Read file')
      case 'search_text':
      case 'search_project':
        return t('ai_assist_tool_search_text', 'Searched project')
      case 'edit_file':
        return t('ai_assist_tool_edit_file', 'Edited file')
      case 'create_file':
        return t('ai_assist_tool_create_file', 'Created file')
      case 'compile_project':
        return wantsCleanCompile(args)
          ? t('ai_assist_tool_compile_project_clean', 'Rebuilt from scratch')
          : t('ai_assist_tool_compile_project', 'Compiled project')
      case 'get_compile_result':
      case 'get_compile_log':
        return t('ai_assist_tool_get_compile_log', 'Read compile log')
      case 'view_compiled_pdf_page':
        return t('ai_assist_tool_view_pdf_page', 'Viewed PDF page')
      case 'view_compiled_pdf_overview':
        return t('ai_assist_tool_view_pdf_overview', 'Viewed PDF overview')
      case 'search_compiled_pdf':
        return t('ai_assist_tool_search_pdf', 'Searched PDF')
      case 'resolve_pdf_block':
        return t('ai_assist_tool_resolve_pdf_block', 'Found PDF block')
      case 'diff_compiled_pdf':
        return t('ai_assist_tool_diff_pdf', 'Compared PDF builds')
      case 'inspect_compiled_style':
        return t('ai_assist_tool_inspect_pdf_style', 'Checked PDF style')
      case 'highlight_in_pdf':
        return t('ai_assist_tool_highlight_pdf', 'Highlighted in PDF')
      case 'get_project_settings':
        return t(
          'ai_assist_tool_get_project_settings',
          'Checked project settings'
        )
      case 'configure_project_settings':
      case 'configure_compiler_settings':
        return t(
          'ai_assist_tool_configure_project_settings',
          'Configured project settings'
        )
      case 'get_editor_settings':
        return t(
          'ai_assist_tool_get_editor_settings',
          'Checked editor settings'
        )
      case 'configure_editor_settings':
      case 'configure_appearance_settings':
        return t(
          'ai_assist_tool_configure_editor_settings',
          'Configured editor settings'
        )
      case 'list_available_settings':
        return t(
          'ai_assist_tool_list_available_settings',
          'Checked available settings'
        )
      case 'web_search':
        return t('ai_assist_tool_web_search', 'Searched the web')
      case 'web_fetch':
        return t('ai_assist_tool_web_fetch', 'Fetched')
      case 'present_plan':
        return t('ai_assist_tool_present_plan', 'Presented plan')
      case 'read_connector_result':
        return t(
          'ai_assist_tool_read_connector_result',
          'Read more of a connector result'
        )
      case 'search_connector_tools':
        return t('ai_assist_tool_search_connector_tools', 'Loaded connector tools')
      default:
        if (call.name.startsWith('mcp__')) {
          const parts = call.name.split('__')
          const tool = parts.slice(2).join('__') || parts[1] || call.name
          return `Called ${tool}`
        }
        // A call stored before a rename. Its name is the only honest thing we
        // can say about it, so say that rather than mislabelling it.
        return call.name
    }
  }

  if (result?.status === 'stopped') {
    switch (call.name) {
      case 'edit_file':
        return {
          action: t('ai_assist_tool_edit_cancelled', 'Edit cancelled'),
          target: args.path,
          isFile: Boolean(args.path),
        }
      case 'create_file':
        return {
          action: t('ai_assist_tool_create_cancelled', 'Creation cancelled'),
          target: args.path,
          isFile: Boolean(args.path),
        }
      default:
        return {
          action: `${getToolBaseAction()} (${t('ai_assist_tool_cancelled', 'cancelled')})`,
        }
    }
  }

  if (!('result' in call)) {
    return {
      action: t('ai_assist_tool_running', 'Running…'),
      target:
        pdfPendingTarget(call.name, args, t) ||
        args.path ||
        args.file_path ||
        (typeof args.query === 'string' ? args.query : undefined),
      isFile: Boolean(args.path || args.file_path),
    }
  }

  // A web tool that failed still names what it was after
  if (call.name === 'web_search' && (call.isError || result?.error)) {
    return {
      action: t('ai_assist_tool_web_search_failed', 'Web search failed'),
      target: typeof args.query === 'string' ? args.query : undefined,
    }
  }
  if (call.name === 'web_fetch' && (call.isError || result?.error)) {
    const where = result?.title || hostOf(result?.url ?? args.url)
    return {
      action: t('ai_assist_tool_web_fetch_failed', "Couldn't fetch"),
      target: where || undefined,
    }
  }

  // The PDF tools can report a failure as their result, not only as an error
  if (call.isError || (PDF_TOOLS.has(call.name) && result?.error)) {
    return {
      action: `${getToolBaseAction()} (${t('ai_assist_tool_failed', 'failed')})`,
    }
  }

  switch (call.name) {
    case 'get_outline':
      return {
        action: t('ai_assist_tool_get_outline', 'Outlined project'),
        target: args.section ? `section "${args.section}"` : undefined,
      }
    case 'list_files':
      return {
        action: t('ai_assist_tool_list_files', 'Listed files'),
        target: args.glob ? `glob ${args.glob}` : undefined,
      }
    case 'read_file':
      return {
        action: t('ai_assist_tool_read_file', 'Read file'),
        target: args.path,
        isFile: true,
        fileLine: args.range?.from ?? args.from,
        lineRange: formatLineRanges(args, result) ?? undefined,
      }
    case 'search_text':
    case 'search_project':
      return {
        action: t('ai_assist_tool_search_text', 'Searched project'),
        target: t('ai_assist_tool_search_project_detail', {
          query: args.query,
          count: result?.hits?.length ?? 0,
          defaultValue: `"${args.query}" — ${result?.hits?.length ?? 0} hits`,
        }),
      }
    case 'edit_file': {
      const isRejected = result?.status === 'rejected'
      const lineCandidate =
        (result as any)?.startLine ??
        args?.from ??
        args?.startLine
      return {
        action: isRejected
          ? t('ai_assist_tool_edit_file_rejected', 'Edit rejected')
          : t('ai_assist_tool_edit_file', 'Edited file'),
        target: args.path,
        isFile: true,
        fileLine:
          typeof lineCandidate === 'number' && lineCandidate > 0
            ? lineCandidate
            : undefined,
        lineRange: isRejected ? undefined : appliedLineRange(result),
      }
    }
    case 'create_file': {
      const isRejected = result?.status === 'rejected'
      return {
        action: isRejected
          ? t('ai_assist_tool_create_file_rejected', 'File creation rejected')
          : t('ai_assist_tool_create_file', 'Created file'),
        target: args.path,
        isFile: true,
        fileLine: 1,
      }
    }
    case 'compile_project':
      return {
        action: wantsCleanCompile(args)
          ? t('ai_assist_tool_compile_project_clean', 'Rebuilt from scratch')
          : t('ai_assist_tool_compile_project', 'Compiled project'),
        compileCounts: {
          errors: result?.errorCount ?? 0,
          warnings: result?.warningCount ?? 0,
        },
      }
    case 'get_compile_result':
    case 'get_compile_log':
      return {
        action: t('ai_assist_tool_get_compile_log', 'Read compile log'),
        target:
          result?.status === 'none'
            ? t('ai_assist_tool_no_compile_log', 'No compile log')
            : t('ai_assist_tool_compile_project_detail', {
                count: result?.errorCount ?? 0,
                defaultValue: `${result?.errorCount ?? 0} errors`,
              }),
      }
    case 'view_compiled_pdf_page': {
      const badBoxesCount = Array.isArray(result?.badBoxes)
        ? result.badBoxes.length
        : typeof result?.badBoxes === 'number'
          ? result.badBoxes
          : 0
      return {
        action: t('ai_assist_tool_view_pdf_page', 'Viewed PDF page'),
        target: pdfPageTarget(args, result),
        meta: badBoxesCount > 0 ? badBoxesLabel(badBoxesCount, t) : undefined,
      }
    }
    case 'view_compiled_pdf_overview':
      return {
        action: t('ai_assist_tool_view_pdf_overview', 'Viewed PDF overview'),
        target: pdfOverviewTarget(args, result, t),
        meta: pdfOverviewMeta(result, t),
      }
    case 'search_compiled_pdf':
      return {
        action: t('ai_assist_tool_search_pdf', 'Searched PDF'),
        target: pdfQueryTarget(args, result),
        meta: pdfSearchMeta(result, t),
      }
    case 'resolve_pdf_block':
      return {
        action: t('ai_assist_tool_resolve_pdf_block', 'Found PDF block'),
        target:
          pdfSourceSpan(result?.path, result?.line, result?.endLine) ??
          (typeof args.block === 'string' ? args.block : undefined),
      }
    case 'diff_compiled_pdf':
      return {
        action: t('ai_assist_tool_diff_pdf', 'Compared PDF builds'),
        meta:
          result?.changed === false
            ? t('ai_assist_tool_diff_pdf_same', 'no visible change')
            : undefined,
      }
    case 'highlight_in_pdf':
      return {
        action: t('ai_assist_tool_highlight_pdf', 'Highlighted in PDF'),
        target: pdfSourceSpan(args.path, args.line, args.endLine),
        meta:
          typeof result?.count === 'number'
            ? t('ai_assist_tool_pdf_areas', {
                count: result.count,
                defaultValue: `${result.count} area${result.count === 1 ? '' : 's'}`,
              })
            : undefined,
      }
    case 'web_search': {
      return {
        action: t('ai_assist_tool_web_search', 'Searched the web'),
        target: typeof args.query === 'string' ? args.query : undefined,
      }
    }
    // Claude.ai-style: "Fetched" and the page's title. Which part of the
    // page was read is in the expanded detail, not the row.
    case 'web_fetch': {
      const where = result?.title || hostOf(result?.url ?? args.url)
      return {
        action: t('ai_assist_tool_web_fetch', 'Fetched'),
        target: where || undefined,
      }
    }
    default:
      return {
        action: getToolBaseAction(),
      }
  }
}

/**
 * The icon + action + target + diff badge for a single tool call, without
 * any surrounding button or chevron. Shared by the full ToolCallCard (used
 * when several tool calls are listed together) and by callers that already
 * have their own expand/collapse control and just need this inline, e.g. a
 * group header that collapses down to a single tool call.
 */
export function ToolCallSummaryLine({
  call,
  isActive,
}: {
  call: ToolCallRecord
  isActive?: boolean
}) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  // The real connector once the connectors are known, else the server
  // name the call's tool name carries
  const connector = useMcpConnector(call?.name)
  const connectorName = connector?.name
  if (!call) return null
  const summarised = summarise(call, t)
  const summary =
    connectorName && isMcpToolName(call.name)
      ? { ...summarised, target: connectorName }
      : summarised
  const diffStats = diffStatsForCall(call)
  const target = summary.target
  // A fetched page or connector is shown with its site's icon, as Claude.ai does
  const pageUrl =
    call.name === 'web_fetch'
      ? ((call.result as any)?.url ?? (call.args as any)?.url)
      : connector?.url

  return (
    <>
      <span
        className={`ai-assist-tool-call-icon ${isActive ? 'is-active' : ''}`}
        aria-hidden="true"
      >
        {isActive ? (
          <span className="ai-assist-activity-dot" />
        ) : typeof pageUrl === 'string' && pageUrl ? (
          <SiteIcon url={pageUrl} fallback={getToolIcon(call.name || '')} />
        ) : (
          getToolIcon(call.name || '')
        )}
      </span>
      {/* One label for the verb and its target, so a running call's glimmer
          sweeps across both as a single line of text */}
      <span
        className={`ai-assist-tool-call-label ${isActive ? 'is-active' : ''}`}
      >
        <span className="ai-assist-tool-call-action">{summary.action}</span>
        {target && ' '}
        {target &&
          (summary.isFile ? (
            <span
              role="button"
              tabIndex={0}
              className="ai-assist-file-link"
              title={t('ai_assist_open_file', {
                path: target,
                defaultValue: `Open ${target}`,
              })}
              onClick={event => {
                event.stopPropagation()
                openFile(target, summary.fileLine)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.stopPropagation()
                  openFile(target, summary.fileLine)
                }
              }}
            >
              {target}
            </span>
          ) : (
            <span
              className="ai-assist-tool-call-target"
              title={target}
            >
              {target}
            </span>
          ))}
      </span>

      {summary.compileCounts && (
        <span className="ai-assist-tool-call-target">
          <span
            className={
              summary.compileCounts.errors > 0
                ? 'ai-assist-compile-count-error'
                : undefined
            }
          >
            {t('ai_assist_tool_compile_project_detail', {
              count: summary.compileCounts.errors,
              defaultValue: `${summary.compileCounts.errors} errors`,
            })}
          </span>
          {', '}
          <span
            className={
              summary.compileCounts.warnings > 0
                ? 'ai-assist-compile-count-warning'
                : undefined
            }
          >
            {t('ai_assist_tool_compile_project_warnings', {
              count: summary.compileCounts.warnings,
              defaultValue: `${summary.compileCounts.warnings} warnings`,
            })}
          </span>
        </span>
      )}

      {summary.lineRange && (
        <span className="ai-assist-tool-call-range">({summary.lineRange})</span>
      )}

      {summary.meta && (
        <span className="ai-assist-tool-call-meta" title={summary.meta}>
          {summary.meta}
        </span>
      )}

      {diffStats && <DiffStatBadge stats={diffStats} />}
    </>
  )
}

/** Web results read as a list of pages, not as a log of tool output. */
function toolCallDetailClass(call: ToolCallRecord, extra = '') {
  return [
    'ai-assist-tool-call-detail',
    extra,
    call?.name === 'web_search' ? 'is-web' : '',
    call?.name === 'web_fetch' ? 'is-web-fetch' : '',
    isConnectorToolName(call?.name) ? 'is-mcp' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function ToolCallCard({
  call,
  isActive = false,
}: {
  call: ToolCallRecord
  isActive?: boolean
}) {
  // Drop down sub activity lines start folded and follow only the user's
  // clicks; AI actions or later activities never fold or unfold them.
  const signature = toolCallSignature(call)
  const [expanded, setExpanded] = useState<boolean>(
    () =>
      subresultExpansionStore.read(`tool:${call?.id}`, signature) ?? false
  )

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (call?.id) {
      subresultExpansionStore.write(`tool:${call.id}`, next, signature)
    }
  }

  return (
    <div className={`ai-assist-tool-call ${isActive ? 'is-active' : ''}`}>
      <button
        type="button"
        className="ai-assist-tool-call-summary"
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        <ToolCallSummaryLine call={call} isActive={isActive} />

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

      <div
        className={`ai-assist-tool-call-body ${expanded ? 'is-expanded' : ''}`}
        aria-hidden={!expanded}
      >
        <div className={toolCallDetailClass(call)}>
          <ToolCallDetailView call={call} />
        </div>
      </div>
    </div>
  )
}
