import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import { WritingActionId } from '../../writing-tools/actions'
import { writingMenu } from '../../writing-tools/selection-shape'
import { cursorContext } from '../../inline-context/cursor-context'
import { openWritingSession } from '../../writing-tools/extension'
import { rememberLanguage } from '../../writing-tools/preferences'
import { openTexGpt } from '../../texgpt/target'
import {
  consumeMenuRequested,
  getSelectionHistory,
} from '../../writing-tools/history-cache'
import MaterialIcon from '@/shared/components/material-icon'
import { WritingToolsMenu } from './writing-tools-menu'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Read by the selection box (review-tooltip-menu.tsx) before it renders this
 * row, and to decide whether the box is needed at all when comments are off.
 */
export const isAvailable = isWritingToolsAvailable

/**
 * "✨ Writing tools", the row under "Add comment" in the selection box. Same
 * button classes as Add comment, so it looks the same in both themes.
 */
export default function WritingToolsAction() {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const [open, setOpen] = useState(() => consumeMenuRequested())
  const { from, to } = state.selection.main

  // Measured when the menu opens: the container needs the whole document
  const menu = useMemo(
    () =>
      open
        ? writingMenu(
            state.sliceDoc(from, to),
            cursorContext(state.doc.toString(), from).container
          )
        : null,
    [open, state, from, to]
  )

  const start = useCallback(
    (action: WritingActionId, targetLanguage?: string) => {
      const selection = view.state.selection.main
      if (selection.empty) return
      if (action === 'translate' && targetLanguage) {
        rememberLanguage(targetLanguage)
      }
      setOpen(false)
      // Collapsing the selection closes the selection box; the session's own
      // highlight keeps the target visible under the card.
      view.dispatch({
        effects: openWritingSession.of({
          from: selection.from,
          to: selection.to,
          action,
          targetLanguage,
        }),
        selection: { anchor: selection.to },
      })
    },
    [view]
  )

  const handleClick = useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    const selection = view.state.selection.main
    if (selection.empty) {
      setOpen(true)
      return
    }
    const text = view.state.sliceDoc(selection.from, selection.to)
    const cached = getSelectionHistory(text)
    if (cached) {
      if (cached.kind === 'writing-tool') {
        start(cached.action, cached.targetLanguage)
        return
      }
      if (cached.kind === 'texgpt') {
        setOpen(false)
        view.dispatch({
          effects: openTexGpt.of({ from: selection.from, to: selection.to }),
        })
        return
      }
    }
    setOpen(true)
  }, [open, view, start])

  return (
    <div className="ai-writing-tools-action">
      <button
        type="button"
        className="review-tooltip-menu-button review-tooltip-add-comment-button ai-writing-tools-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleClick}
      >
        <MaterialIcon type="auto_awesome" />
        {t('ai_assist_writing_tools', 'Writing tools')}
      </button>
      {menu && (
        <WritingToolsMenu
          actions={menu.actions}
          notice={menu.notice}
          onChoose={start}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
