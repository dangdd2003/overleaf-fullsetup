import { FC, memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import moment from 'moment'
import {
  Copy,
  Check,
  Checks,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowUp,
  GitFork,
} from '@phosphor-icons/react'
import { TranscriptEntry, AssistantBlock, blocksForEntry } from '../../agent/agent-messages'
import { WebSources } from '../../agent/web-sources'
import { ApprovalContext, ApprovalDecision } from '../../agent/agent-events'
import { MarkdownContent } from './markdown-content'
import { CompactBoundary } from './compact-boundary'
import { SubresultGroup, SubresultItem } from './subresult-group'
import { copyToClipboard } from '../../utils/copy-to-clipboard'
import { EditedCodeBadge, getFileEditCalls } from './edited-code-badge'
import { MessageActionButton, useCopyFeedback } from './message-action-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { ImageLightbox } from './image-lightbox'
import { suggestCaptureTitle } from '../../pdf/crop'

export { EditedCodeBadge }

function formatMessageTime(createdAt?: number, id?: string): string {
  let ts = createdAt
  if (!ts && id && id.startsWith('q')) {
    const match = id.match(/^q(\d+)_/)
    if (match) ts = Number(match[1])
  }
  if (!ts) return ''
  return moment(ts).fromNow()
}

type MessageSegment =
  | { type: 'subresults'; items: SubresultItem[] }
  | { type: 'text'; text: string }

export function partitionBlocks(blocks?: AssistantBlock[]): MessageSegment[] {
  if (!Array.isArray(blocks)) return []
  const segments: MessageSegment[] = []
  let currentSubresults: SubresultItem[] = []

  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'text') {
      if (block.text && /\S/.test(block.text)) {
        if (currentSubresults.length > 0) {
          segments.push({ type: 'subresults', items: currentSubresults })
          currentSubresults = []
        }
        segments.push({ type: 'text', text: block.text })
      }
    } else {
      currentSubresults.push(block)
    }
  }

  if (currentSubresults.length > 0) {
    segments.push({ type: 'subresults', items: currentSubresults })
  }

  return segments
}

/**
 * Extracts complete response markdown text from an assistant turn.
 */
function getAssistantResponseText(
  entry: Extract<TranscriptEntry, { role: 'assistant' }>
): string {
  if (entry.text && /\S/.test(entry.text)) {
    return entry.text
  }
  const blocks = blocksForEntry(entry)
  const textParts = blocks
    .filter((b): b is Extract<AssistantBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .filter(Boolean)
  return textParts.join('\n\n')
}

export type AgentMessageViewProps = {
  entry: TranscriptEntry
  pendingApprovalId: string | null
  approvalContext?: ApprovalContext | null
  onDecision: (decision: ApprovalDecision) => void
  isRunning?: boolean
  /** Web pages cited anywhere in the conversation, by source number. */
  webSources?: WebSources
  /** Takes a queued message back into the composer. */
  onTakeBack?: (id: string) => void
  /** Has the run answer a queued message now, cutting short its reply. */
  onSendNow?: (id: string) => void
  /** Handler when user prompt text is copied. */
  onCopyPrompt?: (text: string) => void
  /** Handler when assistant markdown response is copied. */
  onCopyResponse?: (text: string) => void
  /** Rewind prompt into composer input box and drop subsequent turns. */
  onRewindPrompt?: (entry: TranscriptEntry) => void
  /** Fork conversation from this message. */
  onForkFromPrompt?: (entry: TranscriptEntry, andRewindCode?: boolean) => void
  /** Trigger rewind code dialog. */
  onRewindCode?: (entry: TranscriptEntry, willFork?: boolean) => void
  /** Regenerate assistant reply from this turn. */
  onRegenerate?: (entry: TranscriptEntry) => void
  /** Disables Rewind, Fork and Regenerate while a run is going. Copy stays enabled. */
  actionsDisabled?: boolean
  /** Whether this is the latest assistant reply. Regenerate shows only for it; shown when omitted. */
  isLatestAssistant?: boolean
  /**
   * Before the newest compact boundary: no longer sent to the model, so it
   * is shown dimmed and offers only Rewind and Copy.
   */
  compacted?: boolean
  /**
   * A user turn the run has read: two ticks instead of one, as Claude Code
   * marks a message sent and then read.
   */
  read?: boolean
}

export const AgentMessageView: FC<AgentMessageViewProps> = memo(
  function AgentMessageView({
    entry,
    pendingApprovalId,
    approvalContext,
    onDecision,
    isRunning = false,
    webSources,
    onTakeBack,
    onSendNow,
    onCopyPrompt,
    onCopyResponse,
    onRewindPrompt,
    onForkFromPrompt,
    onRewindCode,
    onRegenerate,
    actionsDisabled = false,
    isLatestAssistant,
    compacted = false,
    read = false,
  }) {
  const { t } = useTranslation()
  const { copied, copy } = useCopyFeedback()
  const copyLabel = copied ? t('copied', 'Copied') : t('copy', 'Copy')
  const copyIcon = copied ? (
    <Check size={14} aria-hidden="true" />
  ) : (
    <Copy size={14} aria-hidden="true" />
  )

  const [previewImage, setPreviewImage] = useState<{
    src: string
    title: string
  } | null>(null)
  // Asked to be answered now; stays until the run reads it
  const [sendingNow, setSendingNow] = useState(false)

  if (entry.role === 'compact') {
    return <CompactBoundary entry={entry} />
  }

  if (entry.role === 'user') {
    const timeText = formatMessageTime(entry.createdAt, entry.id)

    const handleCopyPrompt = () => {
      copy(entry.text)
      onCopyPrompt?.(entry.text)
    }

    const handleRewind = () => {
      if (onRewindCode) {
        onRewindCode(entry, false)
      } else if (onRewindPrompt) {
        onRewindPrompt(entry)
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:rewindCode', {
            detail: { entry, willFork: false },
          })
        )
      }
    }

    const handleFork = () => {
      if (onForkFromPrompt) {
        onForkFromPrompt(entry, false)
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:forkFromPrompt', {
            detail: { entry, andRewindCode: false },
          })
        )
      }
    }

    return (
      <div
        className={`ai-assist-user-turn-wrapper${compacted ? ' is-compacted' : ''}`}
      >
        <div
          className={`ai-assist-message ai-assist-message-user${entry.pending ? ' is-queued' : ''}`}
        >
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

          {entry.images && entry.images.length > 0 && (
            <div className="ai-assist-user-images-grid">
              {entry.images.map((img, idx) => {
                const src = `data:${img.mediaType};base64,${img.data}`
                const altText = img.name || 'Attached photo'
                const title =
                  img.name ||
                  suggestCaptureTitle({
                    timestamp: entry.createdAt,
                    mediaType: img.mediaType,
                  })
                return (
                  <a
                    key={idx}
                    href={src}
                    download={title}
                    className="ai-assist-user-image-thumb"
                    title={title}
                    onClick={e => {
                      e.preventDefault()
                      setPreviewImage({ src, title })
                    }}
                  >
                    <img src={src} alt={altText} title={title} />
                  </a>
                )
              })}
            </div>
          )}

          {previewImage && (
            <ImageLightbox
              src={previewImage.src}
              title={previewImage.title}
              downloadName={previewImage.title}
              isOpen={true}
              onClose={() => setPreviewImage(null)}
            />
          )}

          <div className="ai-assist-message-user-text">
            {entry.command && (
              // Only the id and the args are shown; the command's harness and
              // gathered context are sent to the model, never displayed
              <span className="ai-assist-slash-chip">/{entry.command.id}</span>
            )}
            {entry.text}
          </div>

          {/* Greyed until the run reads it, as Claude Code shows a queued message */}
          {entry.pending && (
            <div className="ai-assist-queued-row">
              <span className="ai-assist-queued-label">
                {sendingNow
                  ? t('ai_assist_queued_sending_now', 'Sending now…')
                  : t('ai_assist_queued', 'Queued')}
              </span>
              {onSendNow && !sendingNow && (
                <button
                  type="button"
                  className="ai-assist-queued-send-now"
                  onClick={() => {
                    setSendingNow(true)
                    onSendNow(entry.id)
                  }}
                  title={t(
                    'ai_assist_queued_send_now_hint',
                    'Stop the current reply and have the assistant read this message now'
                  )}
                >
                  <ArrowUp size={12} weight="bold" aria-hidden="true" />
                  {t('ai_assist_queued_send_now', 'Send now')}
                </button>
              )}
              {onTakeBack && !sendingNow && (
                <button
                  type="button"
                  className="ai-assist-queued-take-back"
                  onClick={() => onTakeBack(entry.id)}
                  title={t(
                    'ai_assist_queued_take_back_hint',
                    'Take this message back to edit it before the assistant reads it'
                  )}
                >
                  {t('edit', 'Edit')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Small function buttons right under the user's prompt (as in Claude Code) */}
        {!entry.pending && (
          <div className="ai-assist-user-message-footer">
            {timeText && (
              <span className="ai-assist-user-message-time">{timeText}</span>
            )}
            <OLTooltip
              id={`status-prompt-${entry.id}`}
              description={
                read
                  ? t('ai_assist_message_read', 'Read by the assistant')
                  : t('ai_assist_message_sent', 'Sent')
              }
              overlayProps={{ placement: 'top' }}
            >
              <span
                className={`ai-assist-user-message-status${read ? ' is-read' : ''}`}
                aria-label={
                  read
                    ? t('ai_assist_message_read', 'Read by the assistant')
                    : t('ai_assist_message_sent', 'Sent')
                }
              >
                {read ? (
                  <Checks size={14} weight="bold" aria-hidden="true" />
                ) : (
                  <Check size={14} weight="bold" aria-hidden="true" />
                )}
              </span>
            </OLTooltip>
            <div className="ai-assist-msg-actions ai-assist-msg-actions-user">
              {!compacted && (
                <MessageActionButton
                  id={`fork-prompt-${entry.id}`}
                  label={t('ai_assist_fork_from_prompt', 'Fork conversation from here')}
                  icon={<GitFork size={14} aria-hidden="true" />}
                  onClick={handleFork}
                  disabled={actionsDisabled}
                />
              )}
              <MessageActionButton
                id={`rewind-prompt-${entry.id}`}
                label={t('ai_assist_rewind', 'Rewind')}
                icon={<ArrowCounterClockwise size={14} aria-hidden="true" />}
                onClick={handleRewind}
                disabled={actionsDisabled}
              />
              <MessageActionButton
                id={`copy-prompt-${entry.id}`}
                label={copyLabel}
                icon={copyIcon}
                tone={copied ? 'success' : 'default'}
                onClick={handleCopyPrompt}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  const blocks: AssistantBlock[] = blocksForEntry(entry)
  const segments = partitionBlocks(blocks)

  const fileEditCalls = getFileEditCalls(entry)
  const hasEditedCode = fileEditCalls.length > 0
  const markdownText = getAssistantResponseText(entry)
  const showRegenerate = isLatestAssistant !== false && !compacted
  const showActions = !isRunning && (!!markdownText || showRegenerate)

  const handleCopyResponse = () => {
    if (!markdownText) return
    copy(markdownText)
    onCopyResponse?.(markdownText)
  }

  const handleRegenerate = () => {
    if (onRegenerate) {
      onRegenerate(entry)
    } else {
      window.dispatchEvent(
        new CustomEvent('aiAssist:regenerate', {
          detail: { entry, id: entry.id },
        })
      )
    }
  }

  return (
    <div
      className={`ai-assist-message ai-assist-message-assistant${compacted ? ' is-compacted' : ''}`}
    >
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
          const groupId = `${entry.id}-subresults-${idx}`
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

      {hasEditedCode && (
        <div className="ai-assist-message-edited-code">
          <EditedCodeBadge
            entry={entry}
            toolCalls={fileEditCalls}
          />
        </div>
      )}

      {showActions && (
        <div className="ai-assist-msg-actions ai-assist-msg-actions-assistant">
          {markdownText ? (
            <MessageActionButton
              id={`copy-response-${entry.id}`}
              label={copyLabel}
              icon={copyIcon}
              tone={copied ? 'success' : 'default'}
              onClick={handleCopyResponse}
            />
          ) : null}

          {showRegenerate && (
            <MessageActionButton
              id={`regenerate-${entry.id}`}
              label={t('ai_assist_regenerate', 'Regenerate')}
              icon={<ArrowClockwise size={14} aria-hidden="true" />}
              onClick={handleRegenerate}
              disabled={actionsDisabled}
            />
          )}
        </div>
      )}
    </div>
  )
})
