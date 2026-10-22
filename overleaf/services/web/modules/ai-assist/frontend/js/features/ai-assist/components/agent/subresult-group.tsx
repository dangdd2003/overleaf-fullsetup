import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssistantBlock, ToolCallRecord } from '../../agent/agent-messages'
import { ApprovalContext, ApprovalDecision, ConnectorApproval } from '../../agent/agent-events'
import { EditRequest } from '../../agent/project-handle'
import { ToolCallCard, summarise } from './tool-call-card'
import { ThinkingBlock } from './thinking-block'
import { EditApprovalCard } from './edit-approval-card'
import { SettingsApprovalCard } from './settings-approval-card'
import { PlanApprovalCard } from './plan-approval-card'
import { ConnectorApprovalCard } from './connector-approval-card'
import { ConnectorAuthCard } from './connector-auth-card'
import { DiffStats, sumDiffStats } from './diff-stats'
import { DiffStatBadge } from './diff-stat-badge'
import {
  subresultExpansionStore,
  thinkingSignature,
  toolCallSignature,
} from './subresult-expansion-store'

export { subresultExpansionStore }

type ToolArgs = Record<string, unknown>

function isRecord(value: unknown): value is ToolArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Tool args are model-supplied JSON, so read them as a record or as nothing. */
function toArgs(value: unknown): ToolArgs {
  return isRecord(value) ? value : {}
}

/** The first of several keys that is set (not null or undefined), as text. */
function firstText(...values: unknown[]): string {
  const value = values.find(v => v !== undefined && v !== null)
  return typeof value === 'string' ? value : ''
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

type DecisionHandler = (decision: ApprovalDecision) => void

function renderApprovalCard(
  pendingCall: ToolCallRecord | null | undefined,
  approvalContext: ApprovalContext | null | undefined,
  onDecision: DecisionHandler
) {
  if (!pendingCall) return null
  const args = toArgs(pendingCall.args)
  if (pendingCall.name === 'present_plan') {
    return (
      <PlanApprovalCard
        key={pendingCall.id}
        plan={firstText(args.plan)}
        onDecision={onDecision}
      />
    )
  }
  if (pendingCall.name && pendingCall.name.startsWith('configure_')) {
    return (
      <SettingsApprovalCard
        key={pendingCall.id}
        toolName={pendingCall.name}
        args={args}
        onDecision={onDecision}
      />
    )
  }
  if (pendingCall.name && pendingCall.name.startsWith('mcp__')) {
    const connector: Partial<ConnectorApproval> = approvalContext?.connector ?? {}
    if (approvalContext?.kind === 'connectorAuth') {
      return (
        <ConnectorAuthCard
          key={pendingCall.id}
          connectorId={connector.connectorId ?? ''}
          connectorName={connector.connectorName || 'MCP Connector'}
          toolName={pendingCall.name}
          onDecision={onDecision}
        />
      )
    }
    return (
      <ConnectorApprovalCard
        key={pendingCall.id}
        connectorName={connector.connectorName || 'MCP Connector'}
        toolName={pendingCall.name}
        toolTitle={connector.toolTitle}
        args={args}
        onDecision={onDecision}
      />
    )
  }
  const startLine =
    typeof args.startLine === 'number'
      ? args.startLine
      : (approvalContext?.startLine ?? 1)
  return (
    <EditApprovalCard
      key={pendingCall.id}
      edit={getSafeEdit(pendingCall)}
      startLine={startLine}
      onDecision={onDecision}
    />
  )
}

export type SubresultItem =
  | Extract<AssistantBlock, { type: 'thinking' }>
  | Extract<AssistantBlock, { type: 'tool_call' }>

/** The trailing "s" of a noun counted more than once. */
const plural = (n: number) => (n > 1 ? 's' : '')

/** "1 edit rejected", "2 edits rejected": the noun takes an "s" by count. */
const outcomePhrase = (n: number, noun: string, outcome: string) =>
  `${n === 1 ? `1 ${noun}` : `${n} ${noun}s`} ${outcome}`

/** Calls whose result has come back; the rest are still in flight. */
const settledCalls = (calls: ToolCallRecord[]) =>
  calls.filter(call => call.result !== undefined)

/**
 * A short natural-language recap of what a batch of tool calls did — "Read 2
 * files, searched project" rather than a bare "5 tools" — so the collapsed
 * summary reads like Claude Code's activity line. Falls back to a plain count
 * once more than two distinct kinds of action are mixed together, since
 * spelling out every kind at that point stops being readable.
 */
export function summariseToolCallActions(
  toolCalls: Array<{ name: string; result?: unknown }>
): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ''

  const counts: Record<string, number> = {}
  const writes = {
    edit_file: { rejected: 0, cancelled: 0 },
    create_file: { rejected: 0, cancelled: 0 },
  }
  let cancelledTools = 0
  let validCount = 0
  for (const call of toolCalls) {
    if (!call || !call.name) continue
    validCount++
    const status = isRecord(call.result) ? call.result.status : undefined
    const isRejected = status === 'rejected'
    const isCancelled = status === 'stopped'
    if (call.name === 'edit_file' || call.name === 'create_file') {
      const tally = writes[call.name]
      if (isRejected) {
        tally.rejected++
        continue
      }
      if (isCancelled || !call.result || (status && status !== 'applied')) {
        tally.cancelled++
        continue
      }
    }
    if (isCancelled) {
      cancelledTools++
      continue
    }
    counts[call.name] = (counts[call.name] ?? 0) + 1
  }

  if (validCount === 0) return ''

  const parts: string[] = []
  if (counts['read_file']) {
    const n = counts['read_file']
    parts.push(`Read ${n} file${plural(n)}`)
  }
  if (counts['get_references'] || counts['list_references']) {
    parts.push('checked references')
  }
  if (counts['get_outline'] || counts['project_map'] || counts['outline_project']) {
    parts.push('outlined project')
  }
  if (counts['list_files']) {
    parts.push('listed files')
  }
  if (counts['get_packages']) {
    parts.push('checked packages')
  }
  const searchCount = (counts['search_text'] ?? 0) + (counts['search_project'] ?? 0)
  if (searchCount > 0) {
    parts.push(`searched project${searchCount > 1 ? ` (${searchCount})` : ''}`)
  }
  if (counts['web_search']) {
    const n = counts['web_search']
    parts.push(`searched the web${n > 1 ? ` (${n})` : ''}`)
  }
  if (counts['web_fetch']) {
    const n = counts['web_fetch']
    parts.push(`fetched ${n} page${plural(n)}`)
  }
  const compileCount =
    (counts['compile_project'] ?? 0) +
    (counts['get_compile_result'] ?? 0) +
    (counts['get_compile_log'] ?? 0)
  if (compileCount > 0) {
    parts.push(`compiled project${compileCount > 1 ? ` (${compileCount})` : ''}`)
  }
  if (counts['edit_file']) {
    const n = counts['edit_file']
    parts.push(`edited ${n} file${plural(n)}`)
  }
  if (counts['create_file']) {
    const n = counts['create_file']
    parts.push(`created ${n} file${plural(n)}`)
  }
  if (counts['present_plan']) {
    parts.push('presented plan')
  }
  for (const [tool, noun] of [
    ['edit_file', 'edit'],
    ['create_file', 'file creation'],
  ] as const) {
    const tally = writes[tool]
    if (tally.rejected > 0) {
      parts.push(outcomePhrase(tally.rejected, noun, 'rejected'))
    }
    if (tally.cancelled > 0) {
      parts.push(outcomePhrase(tally.cancelled, noun, 'cancelled'))
    }
  }
  if (cancelledTools > 0 && parts.length === 0) {
    parts.push(cancelledTools === 1 ? '1 tool cancelled' : `${cancelledTools} tools cancelled`)
  }
  const configuredSettingsCount =
    (counts['configure_project_settings'] ?? 0) +
    (counts['configure_editor_settings'] ?? 0) +
    (counts['configure_appearance_settings'] ?? 0) +
    (counts['configure_compiler_settings'] ?? 0)
  if (configuredSettingsCount > 0) {
    parts.push(`configured settings${configuredSettingsCount > 1 ? ` (${configuredSettingsCount})` : ''}`)
  }
  const checkedSettingsCount =
    (counts['get_project_settings'] ?? 0) +
    (counts['get_editor_settings'] ?? 0) +
    (counts['list_available_settings'] ?? 0)
  if (checkedSettingsCount > 0) {
    parts.push(`checked settings${checkedSettingsCount > 1 ? ` (${checkedSettingsCount})` : ''}`)
  }

  if (parts.length > 0 && parts.length <= 2) {
    return parts
      .map((p, idx) => (idx === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
      .join(', ')
  }
  return `Used ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}`
}

export function formatSubresultsSummary(
  items: SubresultItem[],
  isLive: boolean
): { title: string; isOnlyThinking: boolean; diffStats: DiffStats | null } {
  const toolCalls = items
    .filter(
      (i): i is Extract<AssistantBlock, { type: 'tool_call' }> =>
        i.type === 'tool_call' && Boolean(i.call)
    )
    .map(i => i.call)

  const callsToTally = isLive ? settledCalls(toolCalls) : toolCalls

  const diffStats = sumDiffStats(callsToTally)

  const thinkingBlocks = items.filter(
    (i): i is Extract<AssistantBlock, { type: 'thinking' }> => i.type === 'thinking'
  )

  const totalThinkingMs = thinkingBlocks.reduce(
    (sum, b) => sum + (b.elapsedMs ?? 0),
    0
  )
  const totalSec = Math.max(1, Math.round(totalThinkingMs / 1000))
  const thoughtTimeStr = totalThinkingMs > 0 ? `Thought for ${totalSec}s` : null

  if (callsToTally.length === 0) {
    if (!isLive && thoughtTimeStr) {
      return { title: thoughtTimeStr, isOnlyThinking: true, diffStats: null }
    }
    return { title: '', isOnlyThinking: false, diffStats: null }
  }

  const actionsStr = summariseToolCallActions(callsToTally)
  if (!actionsStr) {
    return { title: '', isOnlyThinking: false, diffStats: null }
  }

  if (!isLive && thoughtTimeStr) {
    return {
      title: `${actionsStr} · ${thoughtTimeStr}`,
      isOnlyThinking: false,
      diffStats,
    }
  }

  return { title: actionsStr, isOnlyThinking: false, diffStats }
}

function isEditAction(
  value: unknown
): value is NonNullable<EditRequest['action']> {
  return (
    value === 'create' ||
    value === 'append' ||
    value === 'delete' ||
    value === 'edit'
  )
}

function getSafeEdit(call: ToolCallRecord): EditRequest {
  const name = call.name || ''
  const args = toArgs(call.args)
  const isCreateTool = name === 'create_file'
  const oldText = isCreateTool
    ? ''
    : firstText(args.oldText, args.old_text, args.old_string)
  const newText = isCreateTool
    ? firstText(args.content, args.newText)
    : firstText(args.newText, args.new_text, args.new_string, args.content)

  const action: NonNullable<EditRequest['action']> = isEditAction(args.action)
    ? args.action
    : isCreateTool
      ? 'create'
      : !oldText
        ? 'append'
        : !newText
          ? 'delete'
          : 'edit'

  return {
    path: firstText(args.path),
    oldText,
    newText,
    action,
    toolName: name,
    startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
  }
}

export const SubresultGroup: FC<{
  groupId?: string
  items: SubresultItem[]
  isLive?: boolean
  pendingApprovalId?: string | null
  approvalContext?: ApprovalContext | null
  onDecision: DecisionHandler
}> = ({
  groupId,
  items,
  isLive = false,
  pendingApprovalId,
  approvalContext,
  onDecision,
}) => {
  const { t } = useTranslation()

  // A new activity line starts folded. Only the user's click on this line's
  // own header folds or unfolds it; nothing the run does afterwards does.
  const firstItem = items[0]
  const signature = !firstItem
    ? ''
    : firstItem.type === 'tool_call'
      ? toolCallSignature(firstItem.call)
      : thinkingSignature(firstItem.thinking)

  const [expanded, setExpanded] = useState<boolean>(
    () =>
      (groupId && subresultExpansionStore.read(groupId, signature)) || false
  )

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (groupId) {
      subresultExpansionStore.write(groupId, next, signature)
    }
    if (next) {
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    }
  }

  const pendingCallItem = items.find(
    (i): i is Extract<AssistantBlock, { type: 'tool_call' }> =>
      i.type === 'tool_call' &&
      Boolean(i.call) &&
      i.call.id === pendingApprovalId &&
      (i.call.name === 'edit_file' ||
        i.call.name === 'create_file' ||
        i.call.name.startsWith('configure_') ||
        i.call.name.startsWith('mcp__') ||
        i.call.name === 'present_plan')
  )

  const pastItems = pendingCallItem
    ? items.filter(i => i !== pendingCallItem)
    : items

  if (items.length === 0) return null

  // If the only item in this segment is pending approval, show the card directly without empty group
  if (pastItems.length === 0 && pendingCallItem) {
    return renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)
  }

  const toolCalls = pastItems.filter(
    (i): i is Extract<AssistantBlock, { type: 'tool_call' }> => i.type === 'tool_call'
  )

  // If there are only thinking items and no tool calls yet
  if (toolCalls.length === 0) {
    return (
      <>
        {pastItems.map((item, idx) => {
          if (item.type === 'thinking') {
            return (
              <ThinkingBlock
                key={`thinking-${idx}`}
                groupId={groupId}
                blockId={`${groupId}-think-${idx}`}
                thinking={item.thinking}
                isLive={isLive && !item.elapsedMs}
                elapsedMs={item.elapsedMs}
              />
            )
          }
          return null
        })}
        {pendingCallItem && renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)}
      </>
    )
  }

  const { title: rawTitle, diffStats } = formatSubresultsSummary(pastItems, isLive)

  const callsForSummary = isLive
    ? settledCalls(toolCalls.map(i => i.call))
    : toolCalls.map(i => i.call)

  // In-flight active tool call or thinking block
  const inFlightCall = toolCalls.find(
    i => i.call && i.call.result === undefined
  )?.call
  const inFlightThinking = pastItems.find(
    i => i.type === 'thinking' && !i.elapsedMs
  )
  const isGroupActive = Boolean(isLive && (inFlightCall || inFlightThinking))

  const inFlightLabel = inFlightCall
    ? (() => {
        const args = toArgs(inFlightCall.args)
        const target =
          [args.path, args.file_path, args.query, args.url].find(
            isNonEmptyString
          ) ?? ''
        switch (inFlightCall.name) {
          case 'read_file':
            return target ? `Read ${target}…` : 'Reading file…'
          case 'edit_file':
            return target ? `Edit ${target}…` : 'Editing file…'
          case 'create_file':
            return target ? `Create ${target}…` : 'Creating file…'
          case 'search_text':
          case 'search_project':
            return target ? `Search "${target}"…` : 'Searching project…'
          case 'compile_project':
            return 'Compiling project…'
          case 'web_search':
            return target ? `Search web: ${target}…` : 'Searching web…'
          case 'web_fetch':
            return target ? `Fetch ${target}…` : 'Fetching…'
          default: {
            const s = summarise(inFlightCall, t)
            const act = s.action && !s.action.startsWith('Running') ? s.action : inFlightCall.name
            return `${act}${target ? ` ${target}` : ''}…`
          }
        }
      })()
    : inFlightThinking
      ? 'Thinking…'
      : 'Running tools…'

  const title = isGroupActive
    ? rawTitle && rawTitle.trim()
      ? `${rawTitle} · ${inFlightLabel}`
      : inFlightLabel
    : rawTitle && rawTitle.trim()
      ? rawTitle
      : expanded && toolCalls.length > 0
        ? (summariseToolCallActions(callsForSummary) || 'Running tools')
        : rawTitle

  const hasTitle = Boolean(title && title.trim())

  // If there is no title to summarize (e.g. live in-flight tool call before completion)
  if (!hasTitle) {
    const thinkingItems = pastItems.filter(
      (i): i is Extract<AssistantBlock, { type: 'thinking' }> => i.type === 'thinking'
    )
    if (thinkingItems.length > 0) {
      return (
        <>
          {thinkingItems.map((item, idx) => (
            <ThinkingBlock
              key={`thinking-${idx}`}
              groupId={groupId}
              blockId={`${groupId}-think-${idx}`}
              thinking={item.thinking}
              isLive={isLive && !item.elapsedMs}
              elapsedMs={item.elapsedMs}
            />
          ))}
          {pendingCallItem && renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)}
        </>
      )
    }

    return pendingCallItem
      ? renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)
      : null
  }

  return (
    <>
      <div className={`ai-assist-subresult-group ${isGroupActive ? 'is-active' : ''}`}>
        <button
          type="button"
          className={`ai-assist-subresult-group-header ${isGroupActive ? 'is-active' : ''}`}
          aria-expanded={expanded}
          onClick={handleToggle}
        >
          {isGroupActive && (
            <span className="ai-assist-activity-dot" aria-hidden="true" />
          )}
          <span
            className={`ai-assist-subresult-group-title ${isGroupActive ? 'is-active' : ''}`}
          >
            {title}
          </span>

          {diffStats && <DiffStatBadge stats={diffStats} />}

          <svg
            className={`ai-assist-subresult-group-chevron ${expanded ? 'is-expanded' : ''}`}
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

        {expanded && (
          <div className="ai-assist-subresult-group-dropdown">
            {pastItems.map((item, idx) => {
              if (item.type === 'thinking') {
                return (
                  <div key={`think-${idx}`} className="ai-assist-subresult-item">
                    <ThinkingBlock
                      groupId={groupId}
                      blockId={`${groupId}-think-${idx}`}
                      thinking={item.thinking}
                      isLive={isLive && !item.elapsedMs}
                      elapsedMs={item.elapsedMs}
                    />
                  </div>
                )
              }

              const { call } = item
              if (!call) return null

              const isCallActive = Boolean(isLive && call.result === undefined)

              return (
                <div
                  key={call.id || `call-${idx}`}
                  className={`ai-assist-subresult-item ${isCallActive ? 'is-active' : ''}`}
                >
                  <ToolCallCard call={call} isActive={isCallActive} />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {pendingCallItem &&
        renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)}
    </>
  )
}
