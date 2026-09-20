import { ChangeEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileText,
  PaperPlaneRight,
  HandPalm,
  PencilSimple,
  ListChecks,
  CaretUp,
  Check,
} from '@phosphor-icons/react'
import {
  OLDropdown,
  OLDropdownMenu,
  OLDropdownToggle,
  OLDropdownItem,
} from '@/shared/components/ol/ol-dropdown-menu'
import useEventListener from '@/shared/hooks/use-event-listener'
import { AttachmentRef } from '../../agent/context/types'
import { parseAttachmentRef } from '../../agent/context/attachments'
import { AgentMode, nextMode } from '../../agent/agent-mode'

export interface AttachedSelection {
  path: string
  from: number
  to: number
  text: string
}

const MENTION_RE = /@([^\s@]*)$/

/**
 * The `@` token being typed immediately before the caret, or null.
 *
 * Stops at whitespace so a completed mention does not reopen the menu on every
 * later keystroke.
 */
export function mentionQueryAt(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(MENTION_RE)
  return match ? match[1] : null
}

export function AgentComposer({
  running,
  paths = [],
  onSend,
  onStop,
  mode = 'manual',
  onModeChange,
  attachments: externalAttachments,
  setAttachments: externalSetAttachments,
  attachedSelection: externalAttachedSelection,
  setAttachedSelection: externalSetAttachedSelection,
  history = [],
}: {
  running: boolean
  paths?: string[]
  onSend: (
    text: string,
    attachments: AttachmentRef[],
    attachedSelection?: AttachedSelection | null
  ) => void
  onStop: () => void
  mode?: AgentMode
  onModeChange?: (mode: AgentMode) => void
  attachments?: AttachmentRef[]
  setAttachments?: React.Dispatch<React.SetStateAction<AttachmentRef[]>>
  attachedSelection?: AttachedSelection | null
  setAttachedSelection?: React.Dispatch<React.SetStateAction<AttachedSelection | null>>
  history?: string[]
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number>(-1)
  const draftRef = useRef<string>('')
  const [internalAttachments, setInternalAttachments] = useState<AttachmentRef[]>([])
  const [internalAttachedSelection, setInternalAttachedSelection] =
    useState<AttachedSelection | null>(null)

  const attachments = externalAttachments ?? internalAttachments
  const setAttachments = externalSetAttachments ?? setInternalAttachments
  const attachedSelection =
    externalAttachedSelection !== undefined
      ? externalAttachedSelection
      : internalAttachedSelection
  const setAttachedSelection =
    externalSetAttachedSelection ?? setInternalAttachedSelection

  const [query, setQuery] = useState<string | null>(null)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const attachBtnRef = useRef<HTMLButtonElement>(null)

  const modeConfig: Record<
    AgentMode,
    { label: string; desc: string; num: string; icon: React.ReactNode }
  > = {
    manual: {
      label: t('ai_assist_mode_manual', 'Manual'),
      desc: t('ai_assist_mode_manual_desc', 'Approve each change before it applies'),
      num: '1',
      icon: <HandPalm size={15} weight="bold" />,
    },
    acceptEdits: {
      label: t('ai_assist_mode_accept_edits', 'Accept edits'),
      desc: t(
        'ai_assist_mode_accept_edits_desc',
        'Apply file edits without asking'
      ),
      num: '2',
      icon: <PencilSimple size={15} weight="bold" />,
    },
    plan: {
      label: t('ai_assist_mode_plan', 'Plan'),
      desc: t('ai_assist_mode_plan_desc', 'Research first, then propose a plan'),
      num: '3',
      icon: <ListChecks size={15} weight="bold" />,
    },
  }

  const currentModeConfig = modeConfig[mode || 'manual'] || modeConfig.manual

  /**
   * Pick a mode by typing the number shown against it, like Claude Code.
   *
   * Only while the menu is open: the composer textarea has focus otherwise, and
   * there a digit is just text. The accepted keys come from the same `num` the
   * menu renders, so the badge and the shortcut cannot drift apart.
   */
  const onModeMenuKeyDown = (event: KeyboardEvent) => {
    const picked = (Object.keys(modeConfig) as AgentMode[]).find(
      candidate => modeConfig[candidate].num === event.key
    )
    if (!picked) return
    event.preventDefault()
    onModeChange?.(picked)
    setModeMenuOpen(false)
  }

  const toggleAttachMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    setQuery(current => (current !== null ? null : ''))
  }

  useEffect(() => {
    if (query === null) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        attachBtnRef.current &&
        !attachBtnRef.current.contains(target)
      ) {
        setQuery(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [query])

  useEffect(() => {
    setHistoryIndex(-1)
  }, [history])

  useEventListener('aiAssist:selectionChanged', (event: Event) => {
    if (externalSetAttachedSelection) return
    const detail = (event as CustomEvent<AttachedSelection | null>).detail
    if (detail && detail.text) {
      setAttachedSelection(detail)
    } else {
      setAttachedSelection(null)
    }
  })

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value
    const caret = event.target.selectionStart ?? next.length

    if (historyIndex !== -1) {
      setHistoryIndex(-1)
    }

    const completed = next.match(/@([^\s@]+)\s$/)
    if (completed) {
      const ref = parseAttachmentRef(completed[1])
      if (ref && paths.includes(ref.path)) {
        setAttachments(current => [...current, ref])
        setValue(
          next.slice(0, completed.index) +
            next.slice(completed.index! + completed[0].length)
        )
        setQuery(null)
        return
      }
    }

    setValue(next)
    setQuery(mentionQueryAt(next, caret))
  }

  const choose = (path: string) => {
    setAttachments(current => [...current, { path }])
    setValue(current => current.replace(MENTION_RE, ''))
    setQuery(null)
    textareaRef.current?.focus()
  }

  const hasContent =
    Boolean(value.trim()) || attachments.length > 0 || attachedSelection !== null

  const send = () => {
    const trimmed = value.trim()
    if (!trimmed && attachments.length === 0 && !attachedSelection) return
    onSend(trimmed, attachments, attachedSelection)
    setValue('')
    setAttachments([])
    setQuery(null)
    setAttachedSelection(null)
    setHistoryIndex(-1)
    draftRef.current = ''
  }

  const setCaretToEnd = (len: number) => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.selectionStart = len
      textarea.selectionEnd = len
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(len, len)
        }
      })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      onModeChange?.(nextMode(mode || 'manual'))
      return
    }
    if (event.key === 'Escape') {
      if (query !== null) {
        event.preventDefault()
        setQuery(null)
        return
      }
      if (hasContent) {
        // Esc is the way out of whatever you just typed. Stopping the run as
        // well would throw away the model's work to clear a textarea.
        event.preventDefault()
        setValue('')
        setHistoryIndex(-1)
        draftRef.current = ''
        return
      }
      if (running) {
        event.preventDefault()
        onStop()
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // Enter picks from the menu rather than sending a half-typed mention.
      if (query !== null) return
      // While a run is going this queues the message rather than starting a
      // second run; the panel decides which, so the composer just sends.
      send()
      return
    }

    if (query === null && history.length > 0) {
      if (event.key === 'ArrowUp') {
        const textarea = textareaRef.current
        const caret = textarea?.selectionStart ?? 0
        const isAtTopLine = !value.slice(0, caret).includes('\n')

        if (isAtTopLine || historyIndex >= 0 || value === '') {
          event.preventDefault()
          if (historyIndex === -1) {
            draftRef.current = value
          }
          const nextIndex =
            historyIndex === -1
              ? 0
              : Math.min(historyIndex + 1, history.length - 1)
          const targetText = history[history.length - 1 - nextIndex]
          setValue(targetText)
          setHistoryIndex(nextIndex)
          setCaretToEnd(targetText.length)
        }
      } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
        event.preventDefault()
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1
          const targetText = history[history.length - 1 - nextIndex]
          setValue(targetText)
          setHistoryIndex(nextIndex)
          setCaretToEnd(targetText.length)
        } else {
          const draft = draftRef.current
          setValue(draft)
          setHistoryIndex(-1)
          setCaretToEnd(draft.length)
        }
      }
    }
  }

  const matches =
    query === null
      ? []
      : paths
          .filter(path => path.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8)

  const sendLabel = running
    ? t('ai_assist_send_to_running_agent', 'Send to the running agent')
    : t('send', 'Send')

  return (
    <div className="ai-assist-composer">
      <div className="ai-assist-composer-box">
        {query !== null && matches.length > 0 && (
          <ul ref={menuRef} className="ai-assist-mention-menu" role="listbox">
            {matches.map(path => {
              const slash = path.lastIndexOf('/')
              const name = slash === -1 ? path : path.slice(slash + 1)
              const dir = slash === -1 ? null : path.slice(0, slash)
              return (
                <li key={path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-label={path}
                    onClick={() => choose(path)}
                  >
                    <FileText
                      size={15}
                      className="ai-assist-mention-menu-icon"
                      aria-hidden="true"
                    />
                    <span className="ai-assist-mention-menu-name">{name}</span>
                    {dir && (
                      <span className="ai-assist-mention-menu-dir">{dir}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {(attachedSelection || attachments.length > 0) && (
          <div className="ai-assist-selection-chip-wrapper">
            {attachedSelection && (
              <span className="ai-assist-selection-chip">
                <span
                  className="ai-assist-selection-chip-icon"
                  aria-hidden="true"
                >
                  &lt;&gt;
                </span>
                <span className="ai-assist-selection-chip-label">
                  {attachedSelection.path}: {attachedSelection.from}-
                  {attachedSelection.to}
                </span>
                <button
                  type="button"
                  className="ai-assist-selection-chip-close"
                  onClick={() => setAttachedSelection(null)}
                  aria-label={t('remove_selection', 'Remove selection')}
                  title={t('remove_selection', 'Remove selection')}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <line x1="4" y1="4" x2="12" y2="12" />
                    <line x1="12" y1="4" x2="4" y2="12" />
                  </svg>
                </button>
              </span>
            )}
            {attachments.map((attachment, index) => (
              <span
                className="ai-assist-selection-chip"
                key={`${attachment.path}-${index}`}
              >
                <span className="ai-assist-selection-chip-label">
                  {attachment.from != null && attachment.to != null
                    ? `${attachment.path}:${attachment.from}-${attachment.to}`
                    : attachment.path}
                </span>
                <button
                  type="button"
                  className="ai-assist-selection-chip-close"
                  aria-label={t('remove_attachment', 'Remove attachment')}
                  onClick={() =>
                    setAttachments(current =>
                      current.filter((_unused, at) => at !== index)
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <label
          htmlFor="ai-assist-composer-textarea"
          className="visually-hidden"
        >
          {t('ai_assist_composer_placeholder', 'What would you like to do?')}
        </label>
        <textarea
          ref={textareaRef}
          id="ai-assist-composer-textarea"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={t(
            'ai_assist_composer_placeholder',
            'What would you like to do?'
          )}
        />
        <div className="ai-assist-composer-actions">
          <div className="ai-assist-composer-left-actions">
            <button
              ref={attachBtnRef}
              type="button"
              className={`ai-assist-composer-attach-btn ${query !== null ? 'is-active' : ''}`}
              aria-label={t('attach_file', 'Attach context')}
              title={t('attach_file', 'Attach context')}
              aria-expanded={query !== null}
              onClick={toggleAttachMenu}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            <OLDropdown
              drop="up"
              className="d-inline-flex"
              show={modeMenuOpen}
              onToggle={setModeMenuOpen}
              onKeyDown={onModeMenuKeyDown}
            >
              <OLDropdownToggle
                id="ai-assist-mode-toggle"
                as="button"
                className="ai-assist-mode-selector-btn"
                aria-label={t('ai_assist_select_mode', 'Select mode (Shift+Tab to cycle)')}
                title={t('ai_assist_select_mode_tooltip', 'Mode: {{label}} (Shift+Tab to cycle)', { label: currentModeConfig.label })}
              >
                <span className="ai-assist-mode-icon">{currentModeConfig.icon}</span>
                <span className="ai-assist-mode-label">{currentModeConfig.label}</span>
                <CaretUp size={10} weight="bold" className="ai-assist-mode-caret" />
              </OLDropdownToggle>
              <OLDropdownMenu className="ai-assist-mode-menu">
                <div className="ai-assist-mode-menu-header">Mode</div>
                {(['manual', 'acceptEdits', 'plan'] as AgentMode[]).map(m => (
                  <OLDropdownItem
                    key={m}
                    className={`ai-assist-mode-menu-row ${m === (mode || 'manual') ? 'is-selected' : ''}`}
                    onClick={() => onModeChange?.(m)}
                  >
                    <span className="ai-assist-mode-item-icon">{modeConfig[m].icon}</span>
                    <div className="ai-assist-mode-item-text">
                      <span className="ai-assist-mode-item-title">{modeConfig[m].label}</span>
                      <span className="ai-assist-mode-item-desc">{modeConfig[m].desc}</span>
                    </div>
                    <span className="ai-assist-mode-item-num">{modeConfig[m].num}</span>
                  </OLDropdownItem>
                ))}
              </OLDropdownMenu>
            </OLDropdown>
          </div>

          <div className="ai-assist-composer-right-actions">
            {running && !hasContent ? (
              <button
                type="button"
                className="ai-assist-send-btn ai-assist-stop-btn"
                onClick={onStop}
                aria-label={t('stop_esc', 'Stop (Esc)')}
                title={t('stop_esc', 'Stop (Esc)')}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="10" height="10" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className={`ai-assist-send-btn ${hasContent ? 'is-active' : ''}`}
                disabled={!hasContent}
                onClick={send}
                aria-label={sendLabel}
                title={sendLabel}
              >
                <PaperPlaneRight size={16} weight="fill" />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="ai-assist-disclaimer">
        {t(
          'ai_assist_disclaimer',
          'AI can make mistakes. Always check responses.'
        )}
      </p>
    </div>
  )
}
