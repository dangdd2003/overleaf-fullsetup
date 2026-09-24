import { TranscriptEntry, AssistantBlock } from '../../agent/agent-messages'
import { WebSources } from '../../agent/web-sources'
import { MarkdownContent } from './markdown-content'
import { SubresultGroup, SubresultItem } from './subresult-group'
import { ThinkingBlock } from './thinking-block'

export type MessageSegment =
  | { type: 'subresults'; items: SubresultItem[] }
  | { type: 'text'; text: string }

export function partitionBlocks(blocks?: AssistantBlock[]): MessageSegment[] {
  if (!Array.isArray(blocks)) return []
  const segments: MessageSegment[] = []
  let currentSubresults: SubresultItem[] = []

  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'text') {
      if (currentSubresults.length > 0) {
        segments.push({ type: 'subresults', items: currentSubresults })
        currentSubresults = []
      }
      segments.push({ type: 'text', text: block.text || '' })
    } else {
      currentSubresults.push(block)
    }
  }

  if (currentSubresults.length > 0) {
    segments.push({ type: 'subresults', items: currentSubresults })
  }

  return segments
}

export function AgentMessageView({
  entry,
  pendingApprovalId,
  approvalContext,
  onDecision,
  isRunning = false,
  webSources,
}: {
  entry: TranscriptEntry
  pendingApprovalId: string | null
  approvalContext?: { startLine: number } | null
  onDecision: (decision: { accepted: boolean; note?: string }) => void
  isRunning?: boolean
  /** Web pages cited anywhere in the conversation, by source number. */
  webSources?: WebSources
}) {
  if (entry.role === 'user') {
    return (
      <div className="ai-assist-message ai-assist-message-user">
        {entry.attachments && entry.attachments.length > 0 && (
          <div className="ai-assist-selection-chip-wrapper">
            {entry.attachments.map((attachment, index) => (
              <span
                key={`${attachment.path}-${index}`}
                className="ai-assist-selection-chip"
              >
                <span className="ai-assist-selection-chip-label">
                  {attachment.from != null && attachment.to != null
                    ? `${attachment.path}:${attachment.from}-${attachment.to}`
                    : attachment.path}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="ai-assist-message-user-text">{entry.text}</div>
      </div>
    )
  }

  const blocks: AssistantBlock[] =
    entry.blocks && entry.blocks.length > 0
      ? entry.blocks
      : [
          ...(entry.thinking
            ? [
                {
                  type: 'thinking' as const,
                  thinking: entry.thinking,
                  elapsedMs: entry.thinkingElapsedMs,
                },
              ]
            : []),
          ...entry.toolCalls.map(call => ({
            type: 'tool_call' as const,
            call,
          })),
          ...(entry.text ? [{ type: 'text' as const, text: entry.text }] : []),
        ]

  const segments = partitionBlocks(blocks)

  return (
    <div className="ai-assist-message ai-assist-message-assistant">
      {segments.map((segment, idx) => {
        const isLastSegment = idx === segments.length - 1
        const isSegmentLive = isRunning && isLastSegment

        if (segment.type === 'text') {
          return (
            <MarkdownContent
              key={`text-${idx}`}
              content={segment.text}
              isLive={isSegmentLive}
              sources={webSources}
            />
          )
        }

        if (segment.type === 'subresults') {
          const firstItem = segment.items[0]
          const firstItemId =
            firstItem?.type === 'tool_call'
              ? firstItem.call?.id
              : firstItem?.startedAt
                ? `think-${firstItem.startedAt}`
                : null
          const groupId = `${entry.id}-${firstItemId || `subresults-${idx}`}`
          return (
            <SubresultGroup
              key={groupId}
              groupId={groupId}
              items={segment.items}
              isLive={isSegmentLive}
              pendingApprovalId={pendingApprovalId}
              approvalContext={approvalContext}
              onDecision={onDecision}
            />
          )
        }

        return null
      })}
    </div>
  )
}
