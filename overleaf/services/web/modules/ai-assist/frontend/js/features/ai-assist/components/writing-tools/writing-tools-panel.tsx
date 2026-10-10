import {
  KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Warning } from '@phosphor-icons/react'
import classNames from 'classnames'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import {
  closeWritingSession,
  openWritingSession,
  WritingSession,
} from '../../writing-tools/extension'
import { closeTexGpt } from '../../texgpt/target'
import { MAX_SELECTION_CHARS } from '../../writing-tools/actions'
import {
  contextAround,
  documentHints,
  editUnit,
  RephraseSettings,
  splitWhitespace,
} from '../../writing-tools/prompt'
import {
  composeText,
  diffSegments,
  EditUnit,
  planReplace,
} from '../../writing-tools/apply'
import { generate, WritingWarning } from '../../writing-tools/generate'
import { documentClassOf } from '../../texgpt/latex-text'
import { scanPackages } from '../../agent/context/project-index'
import { cursorContext } from '../../inline-context/cursor-context'
import { writingToolsSettings } from '../../writing-tools/model-settings'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import {
  readWritingToolsPreferences,
  writeWritingToolsPreferences,
  WritingToolsPreferences,
} from '../../writing-tools/preferences'
import {
  hasConsented,
  readReasoningEffort,
  readSettings,
  recordConsent,
} from '../../provider-store'
import { ACTION_ICONS, useActionLabel } from './action-labels'
import { DiffText } from './diff-text'
import { RephraseSettingsPanel } from './rephrase-settings'
import { PopupStatusLine, StreamingText } from '../generator/streaming-text'
import { aiEdit } from '../../ai-edit-glow/extension'
import { aiCardWidth } from '../card-width'
import { RevealBox } from '../reveal-box'
import {
  getWritingToolHistory,
  saveWritingToolHistory,
  signalMenuRequested,
} from '../../writing-tools/history-cache'

type Version = { text: string; warnings: WritingWarning[]; unit: EditUnit }

type Phase =
  | { name: 'consent' }
  | { name: 'noProvider' }
  | { name: 'tooLong' }
  | {
      name: 'streaming'
      text: string
      options: string[]
      repairing?: boolean
    }
  | { name: 'ready' }
  | { name: 'unchanged' }
  | { name: 'cannot'; reason: string }
  | { name: 'error'; message: string; hint?: string }

/** Shown inside the TeXGPT popup instead of at the selection. */
export type EmbeddedWritingTools = {
  width: number
  /** Back to the TeXGPT menu. */
  onBack: () => void
  /** Closes the TeXGPT popup. */
  onClose: () => void
  /** The text changed: open again on what is there now. */
  onRestart: () => void
}

/**
 * The result card for one writing session. Keyed on the session id by its
 * host, so a new session always starts clean; the same session keeps this
 * state while its range is re-anchored after edits.
 */
export function WritingToolsPanel({
  session,
  embedded,
}: {
  session: Omit<WritingSession, 'tooltip'>
  embedded?: EmbeddedWritingTools
}) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const permissions = useContext(PermissionsContext) ?? { write: true }
  const label = useActionLabel()

  const parts = useMemo(
    () => splitWhitespace(session.original),
    [session.original]
  )
  const isSynonyms = session.action === 'synonyms'

  const cachedHistory = useMemo(
    () => getWritingToolHistory(session.original, session.action),
    [session.original, session.action]
  )

  const [preferences, setPreferences] = useState<WritingToolsPreferences>(
    readWritingToolsPreferences
  )
  const [phase, setPhase] = useState<Phase>(() => {
    if (
      cachedHistory &&
      (cachedHistory.history.versions.length > 0 || cachedHistory.synonyms.length > 0)
    ) {
      return { name: 'ready' }
    }
    return parts.core.length > MAX_SELECTION_CHARS
      ? { name: 'tooLong' }
      : { name: 'streaming', text: '', options: [] }
  })
  const [history, setHistory] = useState<{ versions: Version[]; index: number }>(() => {
    if (cachedHistory && cachedHistory.history.versions.length > 0) {
      return cachedHistory.history
    }
    return { versions: [], index: 0 }
  })
  const [synonyms, setSynonyms] = useState<string[]>(() => {
    if (cachedHistory && cachedHistory.synonyms.length > 0) {
      return cachedHistory.synonyms
    }
    return []
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsClosing, setSettingsClosing] = useState(false)
  const settingsCloseTimerRef = useRef<number | null>(null)

  const toggleSettings = useCallback(() => {
    if (settingsOpen && !settingsClosing) {
      setSettingsClosing(true)
      if (settingsCloseTimerRef.current) window.clearTimeout(settingsCloseTimerRef.current)
      settingsCloseTimerRef.current = window.setTimeout(() => {
        setSettingsOpen(false)
        setSettingsClosing(false)
      }, 180)
    } else if (!settingsOpen) {
      if (settingsCloseTimerRef.current) window.clearTimeout(settingsCloseTimerRef.current)
      setSettingsOpen(true)
      setSettingsClosing(false)
    }
  }, [settingsOpen, settingsClosing])

  const onSettingsAnimationEnd = useCallback(() => {
    if (settingsClosing) {
      if (settingsCloseTimerRef.current) window.clearTimeout(settingsCloseTimerRef.current)
      setSettingsOpen(false)
      setSettingsClosing(false)
    }
  }, [settingsClosing])

  useEffect(() => {
    return () => {
      if (settingsCloseTimerRef.current) window.clearTimeout(settingsCloseTimerRef.current)
    }
  }, [])
  const [prompt, setPrompt] = useState(() => cachedHistory?.prompt ?? '')
  const [copied, setCopied] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(() => cachedHistory?.durationMs ?? null)
  const startTimeRef = useRef<number>(Date.now())
  const abortRef = useRef<AbortController | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { onScroll: onBodyScroll } = useStickToBottom(bodyRef)
  const [ownWidth] = useState(aiCardWidth)
  const width = embedded?.width ?? ownWidth

  const current = history.versions[history.index]
  /** Per version: the changes the author switched back to their own text. */
  const [kept, setKept] = useState<Map<number, Set<number>>>(() => {
    if (cachedHistory?.kept) {
      const map = new Map<number, Set<number>>()
      for (const [idx, groupArr] of cachedHistory.kept) {
        map.set(idx, new Set(groupArr))
      }
      return map
    }
    return new Map()
  })
  const keptHere = useMemo(
    () => kept.get(history.index) ?? new Set<number>(),
    [kept, history.index]
  )
  const segments = useMemo(
    () =>
      current ? diffSegments(session.original, current.text, current.unit) : [],
    [session.original, current]
  )
  const composed = useMemo(
    () => (current ? composeText(segments, keptHere) : ''),
    [current, segments, keptHere]
  )
  const groupCount = new Set(
    segments.flatMap(s => (s.kind === 'change' ? [s.group] : []))
  ).size
  const allKept = groupCount > 0 && keptHere.size === groupCount
  const toggleChange = useCallback(
    (id: number) =>
      setKept(previous => {
        const set = new Set(previous.get(history.index))
        if (set.has(id)) set.delete(id)
        else set.add(id)
        const nextKept = new Map(previous).set(history.index, set)
        if (history.versions.length > 0) {
          saveWritingToolHistory({
            kind: 'writing-tool',
            originalText: session.original,
            action: session.action,
            targetLanguage: session.targetLanguage,
            history,
            synonyms,
            rephraseSettings: { ...preferences.rephrase, prompt },
            prompt,
            durationMs,
            kept: Array.from(nextKept.entries()).map(([k, s]) => [k, Array.from(s)]),
            timestamp: Date.now(),
          })
        }
        return nextKept
      }),
    [history, session, synonyms, preferences.rephrase, prompt, durationMs]
  )
  const stale = state.sliceDoc(session.from, session.to) !== session.original
  const streaming = phase.name === 'streaming'
  const [flipSide, setFlipSide] = useState(false)

  useLayoutEffect(() => {
    if (settingsOpen && cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect()
      if (rect.left + width + 300 > window.innerWidth) {
        setFlipSide(true)
      } else {
        setFlipSide(false)
      }
    }
  }, [settingsOpen, width])

  const close = useCallback(() => {
    abortRef.current?.abort()
    if (embedded) embedded.onClose()
    else view.dispatch({ effects: closeWritingSession.of(null) })
  }, [view, embedded])

  const run = useCallback(
    async ({
      retry = false,
      rephrase,
    }: { retry?: boolean; rephrase?: RephraseSettings } = {}) => {
      const base = readSettings()
      if (!base?.type || !base.model) {
        setPhase({ name: 'noProvider' })
        return
      }
      if (!hasConsented()) {
        setPhase({ name: 'consent' })
        return
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const doc = view.state.doc.toString()
      const { before, after } = contextAround(doc, session.from, session.to)
      const hints = documentHints(doc)
      const previous = !retry
        ? undefined
        : isSynonyms
          ? synonyms
          : history.versions.map(version => splitWhitespace(version.text).core)

      const rephraseSettings = rephrase ?? { ...preferences.rephrase, prompt }
      const unit = editUnit(session.action, rephraseSettings)
      setPhase({ name: 'streaming', text: '', options: [] })
      startTimeRef.current = Date.now()
      try {
        const outcome = await generate({
          request: {
            action: session.action,
            selection: parts.core,
            before,
            after,
            language: hints.language,
            macros: hints.macros,
            docClass: documentClassOf(doc),
            packages: [...new Set(scanPackages(doc).map(use => use.name))],
            container: cursorContext(doc, session.from).container,
            rephrase: rephraseSettings,
            targetLanguage: session.targetLanguage,
            previous,
          },
          original: session.original,
          doc,
          settings: writingToolsSettings(base, readReasoningEffort(base.type)),
          signal: controller.signal,
          onProgress: progress => {
            if (controller.signal.aborted) return
            setPhase(
              progress.stage === 'repairing'
                ? {
                    name: 'streaming',
                    text: progress.text,
                    options: [],
                    repairing: true,
                  }
                : {
                    name: 'streaming',
                    text: progress.text,
                    options: progress.options,
                  }
            )
          },
        })
        if (controller.signal.aborted) return

        switch (outcome.kind) {
          case 'cannot':
            setPhase({ name: 'cannot', reason: outcome.reason })
            return
          case 'unchanged':
            setPhase({ name: 'unchanged' })
            return
          case 'empty':
            setPhase({
              name: 'error',
              message: isSynonyms
                ? t(
                    'ai_assist_writing_tools_no_synonyms',
                    'No alternatives were suggested.'
                  )
                : t('ai_assist_writing_tools_empty', 'The model returned no text.'),
            })
            return
          case 'synonyms': {
            setSynonyms(outcome.options)
            const synDuration = Date.now() - startTimeRef.current
            setDurationMs(synDuration)
            setPhase({ name: 'ready' })
            saveWritingToolHistory({
              kind: 'writing-tool',
              originalText: session.original,
              action: session.action,
              targetLanguage: session.targetLanguage,
              history: { versions: [], index: 0 },
              synonyms: outcome.options,
              rephraseSettings,
              prompt,
              durationMs: synDuration,
              kept: [],
              timestamp: Date.now(),
            })
            return
          }
          case 'rewrite': {
            const nextVersions = [
              ...history.versions,
              { text: outcome.text, warnings: outcome.warnings, unit },
            ]
            const nextIndex = history.versions.length
            setHistory({
              versions: nextVersions,
              index: nextIndex,
            })
            const rewriteDuration = Date.now() - startTimeRef.current
            setDurationMs(rewriteDuration)
            setPhase({ name: 'ready' })
            saveWritingToolHistory({
              kind: 'writing-tool',
              originalText: session.original,
              action: session.action,
              targetLanguage: session.targetLanguage,
              history: { versions: nextVersions, index: nextIndex },
              synonyms: [],
              rephraseSettings,
              prompt,
              durationMs: rewriteDuration,
              kept: Array.from(kept.entries()).map(([k, s]) => [k, Array.from(s)]),
              timestamp: Date.now(),
            })
            return
          }
        }
      } catch (error: any) {
        if (controller.signal.aborted) return
        setPhase({
          name: 'error',
          message: error?.message || 'The request failed.',
          hint: error?.hint,
        })
      }
    },
    [view, session, parts, preferences, prompt, history, synonyms, isSynonyms, t, kept]
  )

  // Start on open; stop the request when the card goes away
  useEffect(() => {
    if (!cachedHistory && phase.name !== 'tooLong') run()
    cardRef.current?.focus({ preventScroll: true })
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Any mousedown outside the card closes it, as clicking back into the text.
  // In TeXGPT the popup decides.
  useEffect(() => {
    if (embedded) return
    const onMouseDown = (event: MouseEvent) => {
      if (cardRef.current?.contains(event.target as Node)) return
      close()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [close, embedded])

  const replace = useCallback(
    (text: string) => {
      const plan = planReplace(
        view.state,
        { from: session.from, to: session.to, original: session.original },
        text
      )
      if (!plan.ok) return
      view.dispatch({
        changes: plan.changes,
        effects: embedded ? closeTexGpt.of(null) : closeWritingSession.of(null),
        userEvent: 'input.ai-writing-tools',
        annotations: aiEdit.of(true),
        scrollIntoView: true,
      })
      view.focus()
    },
    [view, session, embedded]
  )

  /** Back to the selection box: reselect the text, as a pointer select would. */
  const back = useCallback(() => {
    abortRef.current?.abort()
    if (embedded) {
      embedded.onBack()
      return
    }
    signalMenuRequested()
    view.dispatch({
      effects: closeWritingSession.of(null),
      selection: { anchor: session.from, head: session.to },
      userEvent: 'select',
    })
    view.focus()
  }, [view, session, embedded])

  const retry = useCallback(() => {
    if (stale) {
      // The text under the card changed: start over on what is there now
      if (embedded) {
        embedded.onRestart()
        return
      }
      view.dispatch({
        effects: openWritingSession.of({
          from: session.from,
          to: session.to,
          action: session.action,
          targetLanguage: session.targetLanguage,
        }),
      })
      return
    }
    run({ retry: history.versions.length > 0 || synonyms.length > 0 })
  }, [stale, view, session, run, history.versions.length, synonyms.length, embedded])

  const copy = useCallback(() => {
    if (!current) return
    navigator.clipboard
      ?.writeText(composed)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [current, composed])

  const savePreferences = (next: WritingToolsPreferences) => {
    setPreferences(next)
    writeWritingToolsPreferences(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      view.focus()
      return
    }
    const target = event.target as HTMLElement
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !['TEXTAREA', 'INPUT', 'BUTTON'].includes(target.tagName) &&
      phase.name === 'ready' &&
      current &&
      permissions.write &&
      !stale &&
      !allKept
    ) {
      event.preventDefault()
      replace(composed)
    }
  }

  const ActionIcon = ACTION_ICONS[session.action]
  const title =
    session.action === 'translate' && session.targetLanguage
      ? `${label('translate')} · ${session.targetLanguage}`
      : label(session.action)
  const blocked =
    phase.name === 'consent' ||
    phase.name === 'noProvider' ||
    phase.name === 'tooLong'

  return (
    <div
      ref={cardRef}
      className={classNames('ai-writing-tools-popup-wrapper', {
        'ai-writing-tools-popup-wrapper-reverse': flipSide,
        'is-embedded': Boolean(embedded),
      })}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
    >
      <div className="ai-writing-tools-card" style={{ width }}>
        <div className="ai-writing-tools-card-header">
          <span className="ai-writing-tools-card-title">
            <ActionIcon aria-hidden="true" size={16} weight="bold" />
            {title}
          </span>
          <span className="ai-writing-tools-card-tools">
            {history.versions.length > 1 && (
              <span className="ai-writing-tools-versions">
                <OLIconButton
                  variant="ghost"
                  size="sm"
                  icon="chevron_left"
                  accessibilityLabel={t(
                    'ai_assist_writing_tools_previous',
                    'Previous version'
                  )}
                  disabled={streaming || history.index === 0}
                  onClick={() => {
                    const prevIndex = history.index - 1
                    setHistory(h => ({ ...h, index: prevIndex }))
                    saveWritingToolHistory({
                      kind: 'writing-tool',
                      originalText: session.original,
                      action: session.action,
                      targetLanguage: session.targetLanguage,
                      history: { versions: history.versions, index: prevIndex },
                      synonyms,
                      rephraseSettings: { ...preferences.rephrase, prompt },
                      prompt,
                      durationMs,
                      kept: Array.from(kept.entries()).map(([k, s]) => [k, Array.from(s)]),
                      timestamp: Date.now(),
                    })
                  }}
                />
                <span className="ai-writing-tools-versions-count">
                  {history.index + 1}/{history.versions.length}
                </span>
                <OLIconButton
                  variant="ghost"
                  size="sm"
                  icon="chevron_right"
                  accessibilityLabel={t('ai_assist_writing_tools_next', 'Next version')}
                  disabled={
                    streaming || history.index === history.versions.length - 1
                  }
                  onClick={() => {
                    const nextIndex = history.index + 1
                    setHistory(h => ({ ...h, index: nextIndex }))
                    saveWritingToolHistory({
                      kind: 'writing-tool',
                      originalText: session.original,
                      action: session.action,
                      targetLanguage: session.targetLanguage,
                      history: { versions: history.versions, index: nextIndex },
                      synonyms,
                      rephraseSettings: { ...preferences.rephrase, prompt },
                      prompt,
                      durationMs,
                      kept: Array.from(kept.entries()).map(([k, s]) => [k, Array.from(s)]),
                      timestamp: Date.now(),
                    })
                  }}
                />
              </span>
            )}
            {!isSynonyms && (
              <OLIconButton
                variant="ghost"
                size="sm"
                icon="strikethrough_s"
                active={preferences.showDiff}
                accessibilityLabel={t(
                  'ai_assist_writing_tools_show_changes',
                  'Show changes'
                )}
                onClick={() =>
                  savePreferences({
                    ...preferences,
                    showDiff: !preferences.showDiff,
                  })
                }
              />
            )}
            {session.action === 'rephrase' && (
              <OLIconButton
                variant="ghost"
                size="sm"
                icon="tune"
                active={settingsOpen && !settingsClosing}
                accessibilityLabel={t('ai_assist_writing_tools_settings', 'Settings')}
                onClick={toggleSettings}
              />
            )}
          </span>
        </div>

        <OLButton
          variant="ghost"
          size="sm"
          className="ai-writing-tools-back"
          leadingIcon="arrow_back_ios_new"
          onClick={back}
        >
          {t('ai_assist_writing_tools_back', 'back')}
        </OLButton>

        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="ai-writing-tools-card-body"
          aria-live="polite"
        >
          {phase.name === 'consent' && (
            <div className="ai-writing-tools-notice">
              <p>
                {t(
                  'ai_assist_consent_prompt',
                  'Using the assistant will send project contents and queries to your configured AI provider.'
                )}
              </p>
              <OLButton
                variant="primary"
                size="sm"
                onClick={() => {
                  recordConsent()
                  run()
                }}
              >
                {t('allow_and_continue', 'Allow and continue')}
              </OLButton>
            </div>
          )}

          {phase.name === 'noProvider' && (
            <div className="ai-writing-tools-notice">
              <p>
                {t(
                  'ai_assist_writing_tools_no_provider',
                  'Writing tools use your AI provider. Set one up in your account settings.'
                )}
              </p>
              <a href="/user/settings" target="_blank" rel="noopener noreferrer">
                {t('ai_assist_writing_tools_set_up_provider', 'Set up an AI provider')}
              </a>
            </div>
          )}

          {phase.name === 'tooLong' && (
            <p className="ai-writing-tools-notice">
              {t(
                'ai_assist_writing_tools_too_long',
                'Writing tools work on up to 8,000 characters. Select less text, or ask the AI assistant.'
              )}
            </p>
          )}

          {phase.name === 'streaming' && !isSynonyms && (
            <>
              {phase.text ? <StreamingText text={phase.text} isLive /> : null}
              <PopupStatusLine
                text={
                  phase.repairing
                    ? t(
                        'ai_assist_writing_tools_repairing',
                        'Fixing the LaTeX in this version…'
                      )
                    : t('ai_assist_writing_tools_writing', 'Writing…')
                }
              />
            </>
          )}

          {isSynonyms && (phase.name === 'streaming' || phase.name === 'ready') && (
            <div
              className="ai-writing-tools-synonyms"
              role="group"
              aria-label={label('synonyms')}
            >
              {(phase.name === 'ready' ? synonyms : phase.options).map(option => (
                <OLButton
                  key={option}
                  variant="secondary"
                  size="sm"
                  className={classNames({
                    'ai-assist-stream-fade': phase.name === 'streaming',
                  })}
                  disabled={
                    phase.name !== 'ready' || !permissions.write || stale
                  }
                  onClick={() => replace(parts.lead + option + parts.trail)}
                >
                  {option}
                </OLButton>
              ))}
              {phase.name === 'streaming' && phase.options.length === 0 && (
                <PopupStatusLine
                  text={t('ai_assist_writing_tools_finding', 'Finding alternatives…')}
                />
              )}
            </div>
          )}

          {phase.name === 'ready' && isSynonyms && synonyms.length > 0 && (
            <PopupStatusLine
              completed
              verb="Found"
              durationMs={durationMs ?? undefined}
            />
          )}

          {phase.name === 'ready' && !isSynonyms && current && (
            <>
              <RevealBox animate={preferences.showDiff}>
                <div className="ai-writing-tools-text">
                  {preferences.showDiff ? (
                    <DiffText
                      original={session.original}
                      result={current.text}
                      kept={keptHere}
                      unit={current.unit}
                      onToggle={stale ? undefined : toggleChange}
                    />
                  ) : (
                    composed
                  )}
                </div>
                {current.warnings.length > 0 && (
                  <ul className="ai-writing-tools-warnings">
                    {current.warnings.map(warning => (
                      <li key={warning.message}>
                        <Warning aria-hidden="true" size={18} />
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                )}
              </RevealBox>
              <PopupStatusLine
                completed
                verb={
                  session.action === 'translate'
                    ? 'Translated'
                    : session.action === 'rephrase'
                      ? 'Rephrased'
                      : 'Written'
                }
                durationMs={durationMs ?? undefined}
              />
            </>
          )}

          {phase.name === 'unchanged' && (
            <p className="ai-writing-tools-notice">
              {session.action === 'translate' && session.targetLanguage
                ? t(
                    'ai_assist_writing_tools_already_in_language',
                    'The text is already in {{language}}.',
                    { language: session.targetLanguage }
                  )
                : t(
                    'ai_assist_writing_tools_unchanged',
                    'No changes suggested: the text already does this. Retry for another attempt.'
                  )}
            </p>
          )}

          {phase.name === 'cannot' && (
            <p className="ai-writing-tools-notice">
              {phase.reason ||
                t(
                  'ai_assist_writing_tools_cannot',
                  'This action does not apply to the selected text.'
                )}
            </p>
          )}

          {phase.name === 'error' && (
            <div className="ai-writing-tools-notice ai-writing-tools-error" role="alert">
              <p>{phase.message}</p>
              {phase.hint && <p>{phase.hint}</p>}
            </div>
          )}

          {stale && !blocked && (
            <p className="ai-writing-tools-notice">
              {t(
                'ai_assist_writing_tools_stale',
                'The text changed since this was written. Retry to rewrite the current text.'
              )}
            </p>
          )}
        </div>

        {!blocked && (
          <div className="ai-writing-tools-card-footer ai-card-footer">
            <OLButton
              variant="secondary"
              size="sm"
              leadingIcon="refresh"
              disabled={streaming}
              onClick={retry}
              aria-label={t('ai_assist_writing_tools_retry', 'Retry')}
            >
              <span className="ai-card-label">
                {t('ai_assist_writing_tools_retry', 'Retry')}
              </span>
            </OLButton>
            {!isSynonyms && (
              <span className="ai-writing-tools-card-actions">
                <OLButton
                  variant="secondary"
                  size="sm"
                  leadingIcon={copied ? 'check' : 'content_copy'}
                  disabled={!current || streaming}
                  onClick={copy}
                  aria-label={t('ai_assist_writing_tools_copy', 'Copy')}
                >
                  <span className="ai-card-label">
                    {copied
                      ? t('ai_assist_writing_tools_copied', 'Copied')
                      : t('ai_assist_writing_tools_copy', 'Copy')}
                  </span>
                </OLButton>
                {permissions.write && (
                  <OLButton
                    variant="primary"
                    size="sm"
                    trailingIcon="keyboard_return"
                    disabled={
                      !current || phase.name !== 'ready' || stale || allKept
                    }
                    onClick={() => current && replace(composed)}
                  >
                    {t('ai_assist_writing_tools_replace', 'Replace')}
                  </OLButton>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {(settingsOpen || settingsClosing) && session.action === 'rephrase' && (
        <div
          className={classNames('ai-writing-tools-settings-card', {
            'ai-writing-tools-settings-card-closing': settingsClosing,
          })}
          onAnimationEnd={onSettingsAnimationEnd}
        >
          <RephraseSettingsPanel
            settings={preferences.rephrase}
            prompt={prompt}
            onChange={rephrase => {
              savePreferences({ ...preferences, rephrase })
            }}
            onPromptChange={setPrompt}
            onSubmitPrompt={retry}
          />
        </div>
      )}
    </div>
  )
}
