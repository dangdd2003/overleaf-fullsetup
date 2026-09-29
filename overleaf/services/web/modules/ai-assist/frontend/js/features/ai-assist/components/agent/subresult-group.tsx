import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssistantBlock } from '../../agent/agent-messages'
import {
  ToolCallCard,
  ToolCallSummaryLine,
  toolCallDetailClass,
} from './tool-call-card'
import { ToolCallDetailView } from './tool-call-detail'
import { ThinkingBlock } from './thinking-block'
import { EditApprovalCard } from './edit-approval-card'
import { SettingsApprovalCard } from './settings-approval-card'
import { PlanApprovalCard } from './plan-approval-card'
import { DiffStats, sumDiffStats } from './diff-stats'
import { DiffStatBadge } from './diff-stat-badge'

function renderApprovalCard(
  pendingCall: any,
  approvalContext: any,
  onDecision: any
) {
  if (!pendingCall) return null
  if (pendingCall.name === 'present_plan') {
    return (
      <PlanApprovalCard
        key={pendingCall.id}
        plan={pendingCall.args?.plan || ''}
        onDecision={onDecision}
      />
    )
  }
  if (pendingCall.name && pendingCall.name.startsWith('configure_')) {
    return (
      <SettingsApprovalCard
        key={pendingCall.id}
        toolName={pendingCall.name}
        args={pendingCall.args || {}}
        onDecision={onDecision}
      />
    )
  }
  return (
    <EditApprovalCard
      key={pendingCall.id}
      edit={getSafeEdit(pendingCall)}
      startLine={pendingCall.args?.startLine ?? approvalContext?.startLine ?? 1}
      onDecision={onDecision}
    />
  )
}

export type SubresultItem =
  | Extract<AssistantBlock, { type: 'thinking' }>
  | Extract<AssistantBlock, { type: 'tool_call' }>

/**
 * A short natural-language recap of what a batch of tool calls did — "Read 2
 * files, searched project" rather than a bare "5 tools" — so the collapsed
 * summary reads like Claude Code's activity line. Falls back to a plain count
 * once more than two distinct kinds of action are mixed together, since
 * spelling out every kind at that point stops being readable.
 */
export function summariseToolCallActions(
  toolCalls: Array<{ name: string; result?: any }>
): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ''

  const counts: Record<string, number> = {}
  let rejectedEdits = 0
  let rejectedCreations = 0
  let cancelledEdits = 0
  let cancelledCreations = 0
  let cancelledTools = 0
  let validCount = 0
  for (const call of toolCalls) {
    if (!call || !call.name) continue
    validCount++
    const status = (call.result as any)?.status
    const isRejected = status === 'rejected'
    const isCancelled = status === 'stopped'
    if (call.name === 'edit_file') {
      if (isRejected) {
        rejectedEdits++
        continue
      }
      if (isCancelled || !call.result || (status && status !== 'applied')) {
        cancelledEdits++
        continue
      }
    }
    if (call.name === 'create_file') {
      if (isRejected) {
        rejectedCreations++
        continue
      }
      if (isCancelled || !call.result || (status && status !== 'applied')) {
        cancelledCreations++
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
    parts.push(`Read ${n} file${n > 1 ? 's' : ''}`)
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
    parts.push(`fetched ${n} page${n > 1 ? 's' : ''}`)
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
    parts.push(`edited ${n} file${n > 1 ? 's' : ''}`)
  }
  if (counts['create_file']) {
    const n = counts['create_file']
    parts.push(`created ${n} file${n > 1 ? 's' : ''}`)
  }
  if (rejectedEdits > 0) {
    parts.push(rejectedEdits === 1 ? '1 edit rejected' : `${rejectedEdits} edits rejected`)
  }
  if (cancelledEdits > 0) {
    parts.push(cancelledEdits === 1 ? '1 edit cancelled' : `${cancelledEdits} edits cancelled`)
  }
  if (rejectedCreations > 0) {
    parts.push(rejectedCreations === 1 ? '1 file creation rejected' : `${rejectedCreations} file creations rejected`)
  }
  if (cancelledCreations > 0) {
    parts.push(cancelledCreations === 1 ? '1 file creation cancelled' : `${cancelledCreations} file creations cancelled`)
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
  isLive: boolean,
  _t?: (key: string, opts?: any) => string
): { title: string; isOnlyThinking: boolean; diffStats: DiffStats | null } {
  const toolCalls = items
    .filter(
      (i): i is Extract<AssistantBlock, { type: 'tool_call' }> =>
        i.type === 'tool_call' && Boolean(i.call)
    )
    .map(i => i.call)

  const callsToTally = isLive
    ? toolCalls.filter(call => 'result' in call && call.result !== undefined)
    : toolCalls

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

  if (!isLive && thoughtTimeStr) {
    return {
      title: `${actionsStr} · ${thoughtTimeStr}`,
      isOnlyThinking: false,
      diffStats,
    }
  }

  return { title: actionsStr, isOnlyThinking: false, diffStats }
}

function getSafeEdit(call: any) {
  const name = call.name || ''
  const isCreateTool = name === 'create_file'
  const oldText =
    isCreateTool
      ? ''
      : (call.args?.oldText ??
        call.args?.old_text ??
        call.args?.old_string ??
        '')
  const newText =
    isCreateTool
      ? (call.args?.content ?? call.args?.newText ?? '')
      : (call.args?.newText ??
        call.args?.new_text ??
        call.args?.new_string ??
        call.args?.content ??
        '')

  const action: 'create' | 'append' | 'delete' | 'edit' =
    call.args?.action ??
    (isCreateTool
      ? 'create'
      : !oldText
      ? 'append'
      : !newText
      ? 'delete'
      : 'edit')

  return {
    path: call.args?.path ?? '',
    oldText,
    newText,
    action,
    toolName: name,
    startLine: call.args?.startLine,
  }
}

/**
 * Global store for user fold/unfold intent keyed by group ID.
 * This guarantees that when a user unfolds or folds an activity group,
 * subsequent AI actions (new tool calls, chunk streams, UI re-renders)
 * never automatically flip or collapse the user's chosen expansion state.
 */
export const subresultExpansionStore = new Map<string, boolean>()

export const SubresultGroup: FC<{
  groupId?: string
  items: SubresultItem[]
  isLive?: boolean
  pendingApprovalId?: string | null
  approvalContext?: { startLine: number } | null
  onDecision: (decision: { accepted: boolean; note?: string }) => void
}> = ({
  groupId,
  items,
  isLive = false,
  pendingApprovalId,
  approvalContext,
  onDecision,
}) => {
  const { t } = useTranslation()

  const [userToggled, setUserToggled] = useState<boolean | null>(() => {
    if (groupId && subresultExpansionStore.has(groupId)) {
      return subresultExpansionStore.get(groupId)!
    }
    return null
  })

  // Folding/unfolding is strictly user purpose:
  // whatever AI action happens, keep the activity state the same.
  const expanded =
    userToggled !== null
      ? userToggled
      : groupId && subresultExpansionStore.has(groupId)
        ? subresultExpansionStore.get(groupId)!
        : false

  const handleToggle = () => {
    const next = !expanded
    setUserToggled(next)
    if (groupId) {
      subresultExpansionStore.set(groupId, next)
    }
    if (next) {
      window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
    }
  }

  const pendingCallItem = items.find(
    i =>
      i.type === 'tool_call' &&
      i.call &&
      i.call.id === pendingApprovalId &&
      (i.call.name === 'edit_file' ||
        i.call.name === 'create_file' ||
        i.call.name.startsWith('configure_') ||
        i.call.name === 'present_plan')
  ) as Extract<AssistantBlock, { type: 'tool_call' }> | undefined

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

  const { title, diffStats } = formatSubresultsSummary(pastItems, isLive, t)
  const isSingleToolCall = toolCalls.length === 1 && pastItems.length === 1

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
      <div className="ai-assist-subresult-group">
        <button
          type="button"
          className="ai-assist-subresult-group-header"
          aria-expanded={expanded}
          onClick={handleToggle}
        >
          <span className="ai-assist-subresult-group-title">{title}</span>

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
                      thinking={item.thinking}
                      isLive={isLive && !item.elapsedMs}
                      elapsedMs={item.elapsedMs}
                    />
                  </div>
                )
              }

              const { call } = item
              if (!call) return null

              return (
                <div
                  key={call.id || `call-${idx}`}
                  className="ai-assist-subresult-item"
                >
                  {isSingleToolCall ? (
                    <div className="ai-assist-tool-call">
                      <div className="ai-assist-tool-call-summary ai-assist-tool-call-summary-static">
                        <ToolCallSummaryLine call={call} />
                      </div>
                      <div
                        className={toolCallDetailClass(
                          call,
                          'ai-assist-tool-call-detail-standalone'
                        )}
                      >
                        <ToolCallDetailView call={call} />
                      </div>
                    </div>
                  ) : (
                    <ToolCallCard call={call} />
                  )}
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
