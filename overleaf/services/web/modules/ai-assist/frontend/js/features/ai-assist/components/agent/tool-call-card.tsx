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
} from '@phosphor-icons/react'
import { ToolCallRecord } from '../../agent/agent-messages'
import { diffStatsForCall } from './diff-stats'
import { DiffStatBadge } from './diff-stat-badge'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import { ToolCallDetailView } from './tool-call-detail'

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
    case 'get_project_settings':
    case 'configure_project_settings':
    case 'configure_compiler_settings':
      return <Gear size={size} />
    case 'get_editor_settings':
    case 'configure_editor_settings':
    case 'configure_appearance_settings':
      return <SlidersHorizontal size={size} />
    case 'list_available_settings':
      return <ListChecks size={size} />
    default:
      return <Wrench size={size} />
  }
}

export type ToolSummary = {
  action: string
  target?: string
  isFile?: boolean
  fileLine?: number
  lineRange?: string
}

export function formatLineRanges(args: any, result: any): string | null {
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

export function summarise(
  call: ToolCallRecord,
  t: (key: string, opts?: any) => string
): ToolSummary {
  if (!call || typeof call !== 'object') {
    return { action: '' }
  }
  const args = (call.args ?? {}) as any
  const result = call.result as any

  if (!('result' in call)) {
    return { action: t('ai_assist_tool_running', 'Running…') }
  }

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
        return t('ai_assist_tool_compile_project', 'Compiled project')
      case 'get_compile_result':
      case 'get_compile_log':
        return t('ai_assist_tool_get_compile_log', 'Read compile log')
      case 'get_project_settings':
        return t('ai_assist_tool_get_project_settings', 'Checked project settings')
      case 'configure_project_settings':
      case 'configure_compiler_settings':
        return t('ai_assist_tool_configure_project_settings', 'Configured project settings')
      case 'get_editor_settings':
        return t('ai_assist_tool_get_editor_settings', 'Checked editor settings')
      case 'configure_editor_settings':
      case 'configure_appearance_settings':
        return t('ai_assist_tool_configure_editor_settings', 'Configured editor settings')
      case 'list_available_settings':
        return t('ai_assist_tool_list_available_settings', 'Checked available settings')
      default:
        // A call stored before a rename. Its name is the only honest thing we
        // can say about it, so say that rather than mislabelling it.
        return call.name
    }
  }

  if (call.isError) {
    return { action: `${getToolBaseAction()} (${t('ai_assist_tool_failed', 'failed')})` }
  }

  switch (call.name) {
    case 'get_references':
    case 'list_references':
      return {
        action: t('ai_assist_tool_list_references', 'Checked references'),
      }
    case 'get_outline':
      return {
        action: t('ai_assist_tool_get_outline', 'Outlined project'),
        target: args.section ? `section "${args.section}"` : undefined,
      }
    case 'get_packages':
      return {
        action: t('ai_assist_tool_get_packages', 'Checked packages'),
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
        args?.startLine ??
        (call as any)?.startLine
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
        action: t('ai_assist_tool_compile_project', 'Compiled project'),
        target: t('ai_assist_tool_compile_project_detail', {
          count: result?.errorCount ?? 0,
          defaultValue: `${result?.errorCount ?? 0} errors`,
        }),
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
    case 'get_project_settings':
      return {
        action: t('ai_assist_tool_get_project_settings', 'Checked project settings'),
      }
    case 'configure_project_settings':
    case 'configure_compiler_settings':
      return {
        action: t('ai_assist_tool_configure_project_settings', 'Configured project settings'),
      }
    case 'get_editor_settings':
      return {
        action: t('ai_assist_tool_get_editor_settings', 'Checked editor settings'),
      }
    case 'configure_editor_settings':
    case 'configure_appearance_settings':
      return {
        action: t('ai_assist_tool_configure_editor_settings', 'Configured editor settings'),
      }
    case 'list_available_settings':
      return {
        action: t('ai_assist_tool_list_available_settings', 'Checked available settings'),
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
export function ToolCallSummaryLine({ call }: { call: ToolCallRecord }) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  if (!call) return null
  const summary = summarise(call, t)
  const diffStats = diffStatsForCall(call)

  return (
    <>
      <span className="ai-assist-tool-call-icon" aria-hidden="true">
        {getToolIcon(call.name || '')}
      </span>
      <span className="ai-assist-tool-call-action">{summary.action}</span>
      {summary.target &&
        (summary.isFile ? (
          <span
            role="button"
            tabIndex={0}
            className="ai-assist-file-link"
            title={t('ai_assist_open_file', {
              path: summary.target,
              defaultValue: `Open ${summary.target}`,
            })}
            onClick={event => {
              event.stopPropagation()
              openFile(summary.target!, summary.fileLine)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.stopPropagation()
                openFile(summary.target!, summary.fileLine)
              }
            }}
          >
            {summary.target}
          </span>
        ) : (
          <span className="ai-assist-tool-call-target">
            {summary.target}
          </span>
        ))}

      {summary.lineRange && (
        <span className="ai-assist-tool-call-range">
          ({summary.lineRange})
        </span>
      )}

      {diffStats && <DiffStatBadge stats={diffStats} />}
    </>
  )
}

export const toolCallExpansionStore = new Map<string, boolean>()

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(() => {
    if (call?.id && toolCallExpansionStore.has(call.id)) {
      return toolCallExpansionStore.get(call.id)!
    }
    return null
  })

  const expanded =
    userToggled !== null
      ? userToggled
      : call?.id && toolCallExpansionStore.has(call.id)
        ? toolCallExpansionStore.get(call.id)!
        : false

  const handleToggle = () => {
    const next = !expanded
    setUserToggled(next)
    if (call?.id) {
      toolCallExpansionStore.set(call.id, next)
    }
  }

  return (
    <div className="ai-assist-tool-call">
      <button
        type="button"
        className="ai-assist-tool-call-summary"
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        <ToolCallSummaryLine call={call} />

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
        <div className="ai-assist-tool-call-detail">
          <ToolCallDetailView call={call} />
        </div>
      </div>
    </div>
  )
}
