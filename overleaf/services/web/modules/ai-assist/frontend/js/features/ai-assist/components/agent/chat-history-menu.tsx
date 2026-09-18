import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClockCounterClockwise, Trash } from '@phosphor-icons/react'
import {
  OLDropdown,
  OLDropdownMenu,
  OLDropdownToggle,
} from '@/shared/components/ol/ol-dropdown-menu'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { ChatSummary, listChats } from '../../agent/chat-history-client'

function formatWhen(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ChatHistoryMenu({
  projectId,
  activeChatId,
  onOpen,
  onDelete,
}: {
  projectId: string
  activeChatId: string
  onOpen: (chatId: string) => void
  onDelete: (chatId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [failed, setFailed] = useState(false)

  const onToggle = useCallback(
    (open: boolean) => {
      if (!open) return
      setFailed(false)
      listChats(projectId)
        .then(setChats)
        .catch(() => setFailed(true))
    },
    [projectId]
  )

  const label = t('ai_assist_chat_history', 'Chat history')

  return (
    <OLDropdown align="end" onToggle={onToggle}>
      <OLTooltip
        id="ai-assist-history-tooltip"
        description={label}
        overlayProps={{ placement: 'bottom' }}
      >
        <span>
          <OLDropdownToggle
            id="ai-assist-history-toggle"
            as="button"
            className="btn icon-button-small rail-panel-header-button-subdued d-inline-flex align-items-center justify-content-center ai-assist-history-toggle"
            aria-label={label}
          >
            <ClockCounterClockwise size={18} />
          </OLDropdownToggle>
        </span>
      </OLTooltip>
      <OLDropdownMenu className="ai-assist-history-menu">
        {failed ? (
          <li className="ai-assist-history-empty">
            {t('ai_assist_chat_history_failed', 'Could not load chat history')}
          </li>
        ) : chats === null ? (
          <li className="ai-assist-history-empty">{t('loading', 'Loading')}…</li>
        ) : chats.length === 0 ? (
          <li className="ai-assist-history-empty">
            {t('ai_assist_chat_history_empty', 'No saved chats yet')}
          </li>
        ) : (
          chats.map(chat => {
            const isActive = chat.id === activeChatId
            return (
              <li
                key={chat.id}
                className={`ai-assist-history-row ${isActive ? 'is-active' : ''}`}
              >
                <button
                  type="button"
                  className="ai-assist-history-item-btn"
                  onClick={() => onOpen(chat.id)}
                  title={chat.title || t('ai_assist_untitled_chat', 'Untitled chat')}
                >
                  <span className="ai-assist-history-title">
                    {chat.title || t('ai_assist_untitled_chat', 'Untitled chat')}
                  </span>
                  <span className="ai-assist-history-when">
                    {formatWhen(chat.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="ai-assist-history-delete"
                  aria-label={t('delete', 'Delete')}
                  title={t('delete', 'Delete')}
                  onClick={event => {
                    event.stopPropagation()
                    void onDelete(chat.id).then(() =>
                      setChats(current =>
                        current ? current.filter(c => c.id !== chat.id) : current
                      )
                    )
                  }}
                >
                  <Trash size={15} weight="bold" />
                </button>
              </li>
            )
          })
        )}
      </OLDropdownMenu>
    </OLDropdown>
  )
}
