import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { getTooltip } from '@codemirror/view'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import { hasConsented, recordConsent } from '../../provider-store'
import { resolveSlotModel } from '../../language-suggestions/model-choice'
import { TEXGPT_SYSTEM } from '../../texgpt/prompt'
import { TEXGPT_MAX_TOKENS } from '../../texgpt/generate'
import { useProjectSource } from '../../texgpt/use-project-source'
import { cancelSuggestion, startSuggestion } from '../../inline-suggestion/engine'
import { chatTextStream } from '../../inline-suggestion/stream'
import {
  closeInlinePopup,
  InlinePopup,
  inlinePopupField,
  openInlinePopup,
} from '../../inline-suggestion/popup-field'
import {
  buildEmptyLineRequest,
  noticeForEmpty,
  shapeLatex,
} from '../../empty-line-prompt/request'
import { requestCompletion } from '../../completion/trigger'
import { TexGptPromptBar } from '../texgpt/texgpt-prompt-bar'
import { InlineNotice, TexGptNotice } from '../texgpt/texgpt-notices'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Registered in `sourceEditorComponents`. Portals the empty-line prompt bar,
 * or sentence completion's notice, into the CodeMirror tooltip the popup
 * field provides, so it scrolls with the line like any editor tooltip.
 */
export default function InlinePopupHost() {
  if (!isWritingToolsAvailable()) return null
  return <InlinePopupPortal />
}

function InlinePopupPortal() {
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const popup = state.field(inlinePopupField, false)
  if (!popup) return null
  const tooltipView = getTooltip(view, popup.tooltip)
  if (!tooltipView) return null
  return createPortal(
    <InlinePopupContent key={popup.id} popup={popup} />,
    tooltipView.dom
  )
}

function InlinePopupContent({ popup }: { popup: InlinePopup }) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const loadSource = useProjectSource()
  const [prompt, setPrompt] = useState(popup.prompt)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<TexGptNotice | null>(popup.notice)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Bumped by every send and every stop; a stale run does nothing more. */
  const runRef = useRef(0)
  const runningRef = useRef(false)

  const setRunningState = useCallback((value: boolean) => {
    runningRef.current = value
    setRunning(value)
  }, [])

  const close = useCallback(
    (focus: boolean) => {
      if (view.state.field(inlinePopupField, false)?.id === popup.id) {
        view.dispatch({ effects: closeInlinePopup.of(null) })
      }
      if (focus) view.focus()
    },
    [view, popup.id]
  )

  const stop = useCallback(() => {
    runRef.current++
    cancelSuggestion(view)
    setRunningState(false)
  }, [view, setRunningState])

  // A click anywhere else closes it (and stops a request still waiting for text)
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      if (runningRef.current) stop()
      close(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [close, stop])

  /** Puts the bar back, with the prompt, to say what went wrong. */
  const reopen = (pos: number, text: string, problem: TexGptNotice) =>
    view.dispatch({
      effects: openInlinePopup.of({ pos, mode: 'prompt', prompt: text, notice: problem }),
    })

  const send = async () => {
    const text = prompt.trim()
    if (!text || runningRef.current) return
    const fastModel = resolveSlotModel('fast')
    const mainModel = resolveSlotModel('main')
    const primaryModel = fastModel ?? mainModel
    const fallbackModel = fastModel ? mainModel : null
    if (!primaryModel) {
      setNotice({ name: 'noProvider' })
      return
    }
    if (!hasConsented()) {
      setNotice({ name: 'consent' })
      return
    }
    setNotice(null)
    const run = ++runRef.current
    setRunningState(true)
    let pos = popup.pos
    try {
      const source = await loadSource()
      const at = view.state.field(inlinePopupField, false)
      if (run !== runRef.current || at?.id !== popup.id) return
      pos = at.pos
      const outcome = await startSuggestion(view, {
        source: 'prompt',
        pos,
        stream: chatTextStream({
          settings: primaryModel.settings,
          fallbackSettings: fallbackModel?.settings ?? null,
          system: TEXGPT_SYSTEM,
          messages: [
            {
              role: 'user',
              content: buildEmptyLineRequest({
                doc: view.state.doc.toString(),
                pos,
                prompt: text,
                source,
              }),
            },
          ],
          maxTokens: TEXGPT_MAX_TOKENS,
        }),
        shape: shapeLatex,
        // The rest streams in the editor, where Tab and Esc work
        onFirstText: () => close(true),
      })
      if (run !== runRef.current) return
      if (outcome.status === 'empty') reopen(pos, text, noticeForEmpty(outcome.raw))
      else if (outcome.status === 'cancelled') setRunningState(false)
    } catch (error: any) {
      if (run !== runRef.current) return
      reopen(pos, text, {
        name: 'error',
        message: error?.message || t('ai_assist_texgpt_failed', 'The request failed.'),
        hint: error?.hint,
      })
    }
  }

  const allow = () => {
    recordConsent()
    if (popup.mode === 'notice') {
      close(true)
      requestCompletion(view, { manual: true })
      return
    }
    setNotice(null)
    void send()
  }

  // The bar's own keys; TexGptPromptBar itself is unchanged
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (runningRef.current) stop()
      close(true)
      return
    }
    if (popup.mode !== 'prompt' || prompt !== '') return
    if (event.key === 'Backspace') {
      event.preventDefault()
      close(true)
      return
    }
    if (
      event.key === ' ' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      // Space, Space: a plain space, so a blank line can still be indented
      event.preventDefault()
      const pos = view.state.field(inlinePopupField, false)?.pos ?? popup.pos
      close(true)
      view.dispatch({
        changes: { from: pos, insert: ' ' },
        selection: { anchor: pos + 1 },
        userEvent: 'input.type',
      })
    }
  }

  return (
    <div
      ref={rootRef}
      className={classNames('ai-texgpt-popup', 'ai-inline-popup', {
        'has-result': Boolean(notice),
      })}
      onKeyDownCapture={onKeyDownCapture}
    >
      {popup.mode === 'prompt' && (
        <TexGptPromptBar
          value={prompt}
          placeholder={t('ai_assist_texgpt_placeholder', 'Ask TeXGPT for help with anything')}
          running={running}
          onChange={setPrompt}
          onSend={() => void send()}
          onStop={stop}
        />
      )}
      {notice && (
        <div className="ai-texgpt-result">
          <div className="ai-texgpt-result-body">
            <InlineNotice notice={notice} onConsent={allow} />
          </div>
        </div>
      )}
    </div>
  )
}
