import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import {
  WritingActionId,
  WritingMenuNotice,
} from '../../writing-tools/actions'
import { ACTION_ICONS, useActionLabel } from './action-labels'
import { TranslateMenu } from './translate-menu'
import { TexGptMenuItem, TexGptSparkleIcon } from '../texgpt/texgpt-menu'
import { openAiChat } from '../../hooks/use-ai-dock'

/**
 * The action list under the Writing tools button or the TeXGPT prompt bar.
 * Both are the same menu, Custom prompt (opens the AI chat) included; only
 * the placement differs.
 */
export function WritingToolsMenu({
  actions,
  notice = null,
  onChoose,
  onClose,
  inline = false,
}: {
  actions: WritingActionId[]
  /** Why there are no actions; "Select some text" when not given. */
  notice?: WritingMenuNotice | null
  onChoose: (action: WritingActionId, targetLanguage?: string) => void
  onClose: () => void
  /** Inside the TeXGPT popup: part of the page, under its prompt bar, which keeps the focus. */
  inline?: boolean
}) {
  const { t } = useTranslation()
  const label = useActionLabel()
  const menuRef = useRef<HTMLDivElement>(null)
  const [translateOpen, setTranslateOpen] = useState(false)
  const [above, setAbove] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const closeSoon = () => {
    closeTimerRef.current = window.setTimeout(() => {
      setTranslateOpen(false)
    }, 150)
  }

  // Open upward when there is no room below
  useLayoutEffect(() => {
    if (inline) return
    const rect = menuRef.current?.getBoundingClientRect()
    if (rect && rect.bottom > window.innerHeight - 8) setAbove(true)
  }, [inline])

  useEffect(() => {
    if (inline) return
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true })
  }, [inline])

  useEffect(() => cancelClose, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    // Arrow keys walk the list the focus is in: the actions or the languages
    const list = (event.target as HTMLElement).closest('[role="menu"]')
    if (!list) return
    const items = [
      ...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].filter(item => item.closest('[role="menu"]') === list)
    if (items.length === 0) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(at + step + items.length) % items.length].focus()
  }

  return (
    <div
      ref={menuRef}
      className={classNames('ai-texgpt-menu', 'ai-writing-tools-menu', {
        'ai-writing-tools-menu-inline': inline,
        'ai-writing-tools-menu-above': above,
      })}
      role="menu"
      aria-label={t('ai_assist_writing_tools', 'Writing tools')}
      onKeyDown={onKeyDown}
    >
      <div className="ai-texgpt-menu-group" role="group">
        {actions.length === 0 && (
          <div className="ai-texgpt-menu-empty">
            {notice === 'tooLong'
              ? t(
                  'ai_assist_writing_tools_too_long',
                  'Writing tools work on up to 8,000 characters. Select less text, or ask the AI assistant.'
                )
              : notice === 'noProse'
                ? t(
                    'ai_assist_writing_tools_no_prose',
                    'The selection has no text to rewrite, only math, references or commands'
                  )
                : t(
                    'ai_assist_writing_tools_select_text',
                    'Select some text to use writing tools'
                  )}
          </div>
        )}
        {actions.map(action => {
          const ActionIcon = ACTION_ICONS[action]
          if (action === 'translate') {
            return (
              <div
                key={action}
                className="ai-writing-tools-translate-wrapper"
                onMouseEnter={() => {
                  cancelClose()
                  setTranslateOpen(true)
                }}
                onMouseLeave={closeSoon}
              >
                <TexGptMenuItem
                  icon={<ActionIcon aria-hidden="true" size={18} />}
                  label={label(action)}
                  aria-haspopup="menu"
                  aria-expanded={translateOpen}
                  className={classNames({ active: translateOpen })}
                  trailing={
                    <MaterialIcon
                      type="chevron_right"
                      className="ai-texgpt-menu-item-caret"
                    />
                  }
                  onClick={() => setTranslateOpen(open => !open)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowRight') {
                      event.preventDefault()
                      setTranslateOpen(true)
                    }
                  }}
                />
                {translateOpen && (
                  <TranslateMenu
                    onChoose={language => onChoose('translate', language)}
                    onMouseEnter={cancelClose}
                    onMouseLeave={closeSoon}
                    onBack={() => {
                      setTranslateOpen(false)
                      menuRef.current
                        ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
                        ?.focus()
                    }}
                  />
                )}
              </div>
            )
          }
          return (
            <TexGptMenuItem
              key={action}
              icon={<ActionIcon aria-hidden="true" size={18} />}
              label={label(action)}
              onMouseEnter={() => {
                cancelClose()
                setTranslateOpen(false)
              }}
              onClick={() => onChoose(action)}
            />
          )
        })}
      </div>
      <hr className="ai-texgpt-menu-divider" />
      <div className="ai-texgpt-menu-group" role="group">
        <TexGptMenuItem
          icon={<TexGptSparkleIcon />}
          label={t('ai_assist_texgpt_custom_prompt', 'Custom prompt')}
          onMouseEnter={() => {
            cancelClose()
            setTranslateOpen(false)
          }}
          onClick={() => {
            onClose()
            openAiChat()
          }}
        />
      </div>
    </div>
  )
}
