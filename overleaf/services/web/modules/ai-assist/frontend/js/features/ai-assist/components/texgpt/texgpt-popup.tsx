import {
  KeyboardEvent,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { EditorSelection } from '@codemirror/state'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { AgentMessage } from '../../providers/types'
import {
  hasConsented,
  readReasoningEffort,
  readSettings,
  recordConsent,
} from '../../provider-store'
import { MAX_SELECTION_CHARS, WritingActionId } from '../../writing-tools/actions'
import { writingMenu } from '../../writing-tools/selection-shape'
import {
  readWritingToolsPreferences,
  rememberLanguage,
  writeWritingToolsPreferences,
} from '../../writing-tools/preferences'
import {
  contextAround,
  documentHints,
  splitWhitespace,
} from '../../writing-tools/prompt'
import { planReplace, TextChange } from '../../writing-tools/apply'
import { writingToolsSettings } from '../../writing-tools/model-settings'
import {
  getSelectionHistory,
  saveTexGptHistory,
} from '../../writing-tools/history-cache'
import { WritingToolsMenu } from '../writing-tools/writing-tools-menu'
import { WritingToolsPanel } from '../writing-tools/writing-tools-panel'
import {
  closeTexGpt,
  isStale,
  openTexGpt,
  setTexGptBlock,
  texGptField,
  TexGptRange,
  TexGptState,
} from '../../texgpt/target'
import { insertBelowChange, insertChange, preambleChange } from '../../texgpt/insert'
import { useProjectSource } from '../../texgpt/use-project-source'
import {
  fitPaper,
  flattenDocument,
  paperDigest,
  projectClass,
  projectKeys,
  projectPackages,
} from '../../texgpt/project-text'
import { cursorContext, lineState } from '../../inline-context/cursor-context'
import {
  blockReplacement,
  ExistingBlock,
  findExisting,
  GENERATOR_EXPECT,
  GeneratorId,
  newBlock,
} from '../../texgpt/generators'
import {
  buildFollowUpMessage,
  buildRequestMessage,
  RETRY_MESSAGE,
} from '../../texgpt/prompt'
import { Expect } from '../../texgpt/parse-output'
import { generateTexGpt } from '../../texgpt/generate'
import { documentClassOf } from '../../texgpt/latex-text'
import { AI_CARD_MARGIN, AI_CARD_WIDTH } from '../card-width'
import { TexGptPromptBar } from './texgpt-prompt-bar'
import {
  GENERATOR_ICONS,
  GeneratorMenu,
  useGeneratorLabel,
} from './texgpt-menu'
import MaterialIcon from '@/shared/components/material-icon'
import { TexGptPhase, TexGptResult, TexGptVersion } from './texgpt-result'
import { aiEdit } from '../../ai-edit-glow/extension'
import { openAiChat } from '../../hooks/use-ai-dock'

const POPUP_MAX_WIDTH = AI_CARD_WIDTH
const VIEWPORT_MARGIN = AI_CARD_MARGIN

/** A Writing tool running inside the popup, on the TeXGPT selection. */
type Writing = {
  /** New for every run; the panel keys its state on it. */
  id: number
  action: WritingActionId
  targetLanguage?: string
}

let nextWritingId = 0

type Run = {
  /** Shown in the header: the author's words or the generator's name. */
  title: string
  /** The prompt as typed, put back in the bar on Back. */
  prompt: string
  generator: GeneratorId | null
}

type Request =
  | { kind: 'prompt'; text: string }
  | { kind: 'generator'; id: GeneratorId }
  | { kind: 'followUp'; text: string }
  | { kind: 'retry' }

/** What an apply button writes, and where. */
type Plan = {
  text: string
  /** Replace this range; otherwise insert at the target. */
  range: TexGptRange | null
  /** Insert under the selection instead of at it. */
  below?: boolean
  /** On its own lines even when it is one line. */
  block?: boolean
}

/**
 * The TeXGPT popup under the toolbar button: the prompt bar, then the
 * generators or the Writing tools list, then — once something is asked —
 * the result with its actions. Open while `texGptField` is set.
 */
export function TexGptPopup({ anchorRef }: { anchorRef: RefObject<HTMLElement> }) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const field = state.field(texGptField, false) ?? null
  const loadSource = useProjectSource()
  const generatorLabel = useGeneratorLabel()

  const target = field?.target ?? null
  const replacing = target?.mode === 'replace'
  const selectionText = target?.mode === 'replace' ? target.original : ''
  const selectionFrom = target?.mode === 'replace' ? target.from : null
  const cachedHistory = useMemo(() => {
    if (!selectionText) return null
    return getSelectionHistory(selectionText)
  }, [selectionText])

  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<Run | null>(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.run
    }
    return null
  })
  const [writing, setWriting] = useState<Writing | null>(() => {
    if (cachedHistory?.kind === 'writing-tool') {
      return {
        id: ++nextWritingId,
        action: cachedHistory.action,
        targetLanguage: cachedHistory.targetLanguage,
      }
    }
    return null
  })
  const [phase, setPhase] = useState<TexGptPhase>(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return { name: 'ready' }
    }
    return { name: 'menu' }
  })
  const [versions, setVersions] = useState<TexGptVersion[]>(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.versions
    }
    return []
  })
  const [index, setIndex] = useState(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.index
    }
    return 0
  })
  const [choice, setChoice] = useState(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.choice
    }
    return 0
  })
  const [pending, setPending] = useState<Request | null>(null)
  const [existing, setExisting] = useState<ExistingBlock | null>(null)
  const [partial, setPartial] = useState(false)
  const [addPackages, setAddPackages] = useState(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.addPackages
    }
    return true
  })
  const [showDiff, setShowDiff] = useState(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.showDiff
    }
    return readWritingToolsPreferences().showDiff
  })
  const [durationMs, setDurationMs] = useState<number | null>(() => {
    if (cachedHistory?.kind === 'texgpt') {
      return cachedHistory.durationMs
    }
    return null
  })
  const startTimeRef = useRef<number>(Date.now())
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return null
    const width = Math.min(POPUP_MAX_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN)
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN)
    )
    return { top: rect.bottom + 6, left, width }
  })
  const abortRef = useRef<AbortController | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const promptInputRef = useRef<HTMLTextAreaElement>(null)
  const projectRef = useRef<{ loaded: Set<string>; docClass: string | null }>({
    loaded: new Set(),
    docClass: null,
  })

  const current: TexGptVersion | undefined = versions[index]
  const streaming = phase.name === 'streaming'
  const menu = useMemo(
    () =>
      writingMenu(
        selectionText,
        selectionFrom === null
          ? undefined
          : cursorContext(view.state.doc.toString(), selectionFrom).container
      ),
    [selectionText, selectionFrom, view]
  )

  // Under the button, kept inside the viewport
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(POPUP_MAX_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN)
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN)
      )
      setPosition({ top: rect.bottom + 6, left, width })
    }
    place()
    window.addEventListener('resize', place)
    const toolbar = anchorRef.current?.closest('.ol-cm-toolbar')
    const observer =
      toolbar && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(place)
        : null
    if (toolbar && observer) observer.observe(toolbar)
    return () => {
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [anchorRef])

  const close = useCallback(() => {
    abortRef.current?.abort()
    view.dispatch({ effects: closeTexGpt.of(null) })
  }, [view])

  // Stop the request when the popup goes away, however it closed
  useEffect(() => () => abortRef.current?.abort(), [])

  // With only the menu open, a click elsewhere dismisses it; a result stays
  // open while the author scrolls or clicks in the text
  useEffect(() => {
    if (run || writing) return
    const onMouseDown = (event: MouseEvent) => {
      const node = event.target as Node
      if (popupRef.current?.contains(node) || anchorRef.current?.contains(node)) {
        return
      }
      close()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [run, writing, close, anchorRef])

  const start = async (request: Request) => {
    const base = readSettings()
    if (!base?.type || !base.model) {
      setPhase({ name: 'noProvider' })
      return
    }
    if (!hasConsented()) {
      setPending(request)
      setPhase({ name: 'consent' })
      return
    }
    const now = view.state.field(texGptField, false)
    if (!now) return

    const continuing = request.kind === 'retry' || request.kind === 'followUp'
    const previous = continuing ? versions[index] : undefined
    if (continuing && !previous) return
    const generator =
      request.kind === 'generator'
        ? request.id
        : request.kind === 'prompt'
          ? null
          : (run?.generator ?? null)
    const original =
      !generator && now.target.mode === 'replace' ? now.target.original : ''
    if (
      request.kind === 'prompt' &&
      splitWhitespace(original).core.length > MAX_SELECTION_CHARS
    ) {
      setPhase({ name: 'tooLong' })
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    startTimeRef.current = Date.now()
    setPhase({ name: 'streaming', reply: null, repairing: false })

    try {
      let messages: AgentMessage[]
      let expect: Expect = generator ? GENERATOR_EXPECT[generator] : 'latex'
      if (previous) {
        messages = [
          ...previous.messages,
          { role: 'assistant', content: previous.raw },
          {
            role: 'user',
            content:
              request.kind === 'followUp'
                ? buildFollowUpMessage(request.text)
                : RETRY_MESSAGE,
          },
        ]
      } else {
        const source = await loadSource()
        if (controller.signal.aborted) return
        const loaded = projectPackages(source)
        const docClass = projectClass(source)
        projectRef.current = { loaded, docClass }
        const doc = view.state.doc.toString()
        const hints = documentHints(doc)
        const facts = {
          docClass,
          language: hints.language,
          macros: hints.macros,
          packages: [...loaded].sort(),
        }
        if (request.kind === 'generator') {
          const found = findExisting(request.id, doc, docClass)
          setExisting(found)
          setPartial(!source.complete)
          view.dispatch({
            effects: setTexGptBlock.of(
              found
                ? { from: found.from, to: found.to, original: doc.slice(found.from, found.to) }
                : null
            ),
          })
          messages = [
            {
              role: 'user',
              content: buildRequestMessage({
                ...facts,
                generator: request.id,
                before: '',
                after: '',
                paper: fitPaper(paperDigest(flattenDocument(source))).text,
              }),
            },
          ]
          expect = GENERATOR_EXPECT[request.id]
        } else {
          const at = view.state.field(texGptField, false)?.target ?? now.target
          const from = at.mode === 'replace' ? at.from : at.pos
          const to = at.mode === 'replace' ? at.to : at.pos
          const { before, after } = contextAround(doc, from, to)
          const edges = at.mode === 'replace' ? splitWhitespace(at.original) : null
          messages = [
            {
              role: 'user',
              content: buildRequestMessage({
                ...facts,
                ...projectKeys(source),
                prompt: request.kind === 'prompt' ? request.text : '',
                selection: edges?.core,
                before: before + (edges?.lead ?? ''),
                after: (edges?.trail ?? '') + after,
                where: {
                  ...cursorContext(doc, from),
                  line: at.mode === 'insert' ? lineState(doc, from) : undefined,
                },
              }),
            },
          ]
        }
      }

      const outcome = await generateTexGpt({
        messages,
        expect,
        original,
        loaded: projectRef.current.loaded,
        docClass: projectRef.current.docClass,
        settings: writingToolsSettings(base, readReasoningEffort(base.type)),
        signal: controller.signal,
        onProgress: progress => {
          if (controller.signal.aborted) return
          if (progress.stage === 'repairing') {
            setPhase(shown =>
              shown.name === 'streaming' ? { ...shown, repairing: true } : shown
            )
          } else {
            setPhase({ name: 'streaming', reply: progress.reply, repairing: false })
          }
        },
      })
      if (controller.signal.aborted) return

      let version: TexGptVersion | null = null
      switch (outcome.kind) {
        case 'latex':
          version = {
            kind: 'latex',
            text: outcome.text,
            packages: outcome.packages,
            warnings: outcome.warnings,
            raw: outcome.raw,
            messages,
          }
          break
        case 'answer':
          version = { kind: 'answer', text: outcome.text, raw: outcome.raw, messages }
          break
        case 'options':
          version = { kind: 'options', options: outcome.options, raw: outcome.raw, messages }
          break
        case 'unchanged':
          setPhase({ name: 'unchanged' })
          return
        case 'cannot':
          setPhase({ name: 'cannot', reason: outcome.reason })
          return
        case 'empty':
          setPhase({ name: 'empty' })
          return
      }
      if (!version) return
      const kept = previous ? versions : []
      const nextVersions = [...kept, version]
      const nextIndex = kept.length
      setVersions(nextVersions)
      setIndex(nextIndex)
      setChoice(0)
      setAddPackages(true)
      const nextDuration = Date.now() - startTimeRef.current
      setDurationMs(nextDuration)
      setPhase({ name: 'ready' })
      if (target?.mode === 'replace') {
        const activeRun: Run = run ?? {
          title: request.kind === 'prompt' ? request.text : 'TeXGPT',
          prompt: request.kind === 'prompt' ? request.text : '',
          generator: request.kind === 'generator' ? request.id : null,
        }
        saveTexGptHistory({
          kind: 'texgpt',
          originalText: target.original,
          run: activeRun,
          versions: nextVersions,
          index: nextIndex,
          choice: 0,
          durationMs: nextDuration,
          showDiff,
          addPackages: true,
          timestamp: Date.now(),
        })
      }
    } catch (error: any) {
      if (controller.signal.aborted) return
      setPhase({
        name: 'error',
        message: error?.message || t('ai_assist_texgpt_failed', 'The request failed.'),
        hint: error?.hint,
      })
    }
  }

  const send = () => {
    const text = prompt.trim()
    if (!text || streaming) return
    setPrompt('')
    if (run && current) {
      start({ kind: 'followUp', text })
      return
    }
    setRun({ title: text, prompt: text, generator: null })
    setVersions([])
    setIndex(0)
    start({ kind: 'prompt', text })
  }

  const runGenerator = (id: GeneratorId) => {
    // Find the block to replace now, from the open file, so the footer shows
    // its final buttons (Insert at cursor, Replace …) from the first frame
    // instead of switching once the project has loaded. start() checks again
    // with the project's class.
    const doc = view.state.doc.toString()
    const found = findExisting(
      id,
      doc,
      projectRef.current.docClass ?? documentClassOf(doc)
    )
    setExisting(found)
    view.dispatch({
      effects: setTexGptBlock.of(
        found
          ? { from: found.from, to: found.to, original: doc.slice(found.from, found.to) }
          : null
      ),
    })
    setRun({ title: generatorLabel(id), prompt: '', generator: id })
    setVersions([])
    setIndex(0)
    start({ kind: 'generator', id })
  }

  const back = () => {
    abortRef.current?.abort()
    if (run?.prompt) setPrompt(run.prompt)
    setRun(null)
    setVersions([])
    setIndex(0)
    setExisting(null)
    setPartial(false)
    setPhase({ name: 'menu' })
    view.dispatch({ effects: setTexGptBlock.of(null) })
  }

  const stop = () => {
    abortRef.current?.abort()
    if (versions.length > 0) setPhase({ name: 'ready' })
    else back()
  }

  const retry = () => {
    if (!run || streaming) return
    if (run.generator) {
      if (current) start({ kind: 'retry' })
      else runGenerator(run.generator)
      return
    }
    const now = view.state.field(texGptField, false)
    if (now?.target.mode === 'replace' && isStale(view.state, now.target)) {
      // The text under the target changed: start over on what is there now
      view.dispatch({
        effects: openTexGpt.of({ from: now.target.from, to: now.target.to }),
      })
      setVersions([])
      setIndex(0)
      start({ kind: 'prompt', text: run.prompt })
      return
    }
    start(current ? { kind: 'retry' } : { kind: 'prompt', text: run.prompt })
  }

  const allow = () => {
    recordConsent()
    const request = pending
    setPending(null)
    if (request) start(request)
  }

  // The Writing tool takes over the popup, on the same text
  const chooseWritingTool = (action: WritingActionId, targetLanguage?: string) => {
    const now = view.state.field(texGptField, false)
    if (!now || now.target.mode !== 'replace') return
    if (action === 'translate' && targetLanguage) rememberLanguage(targetLanguage)
    setWriting({ id: ++nextWritingId, action, targetLanguage })
  }

  /** The text changed under the Writing tool: run it again on what is there now. */
  const restartWriting = () => {
    const now = view.state.field(texGptField, false)
    if (now?.target.mode === 'replace') {
      view.dispatch({
        effects: openTexGpt.of({ from: now.target.from, to: now.target.to }),
      })
    }
    setWriting(w => (w ? { ...w, id: ++nextWritingId } : w))
  }

  const planFor = (
    how: 'primary' | 'secondary',
    at: TexGptState | null,
    chosen = choice
  ): Plan | null => {
    if (!at || !current || current.kind === 'answer') return null
    const generator = run?.generator ?? null
    if (generator) {
      const value =
        current.kind === 'options'
          ? generator === 'title'
            ? (current.options[chosen] ?? current.options[0])
            : current.options
          : current.text
      if (value === undefined) return null
      if (how === 'primary' && at.block && existing) {
        return { text: blockReplacement(generator, value, existing), range: at.block }
      }
      if (how === 'secondary' && !at.block) return null
      return {
        text: newBlock(generator, value, projectRef.current.docClass),
        range: null,
        block: true,
      }
    }
    if (current.kind !== 'latex') return null
    if (at.target.mode === 'replace') {
      return how === 'primary'
        ? { text: current.text, range: at.target }
        : { text: current.text, range: null, below: true }
    }
    return how === 'primary' ? { text: current.text, range: null } : null
  }

  const missing = current?.kind === 'latex' ? current.packages : []

  const apply = (how: 'primary' | 'secondary', chosen = choice) => {
    const now = view.state.field(texGptField, false) ?? null
    const plan = planFor(how, now, chosen)
    if (!now || !plan) return
    let changes: TextChange[]
    let end: number
    if (plan.range) {
      const replaced = planReplace(view.state, plan.range, plan.text)
      if (!replaced.ok) return
      changes = replaced.changes
      end = plan.range.to
    } else if (plan.below && now.target.mode === 'replace') {
      const change = insertBelowChange(view.state, now.target.from, now.target.to, plan.text)
      changes = [change]
      end = change.from
    } else {
      const pos = now.target.mode === 'insert' ? now.target.pos : now.target.to
      changes = [
        insertChange(view.state, pos, plan.text, plan.block ? { block: true } : {}),
      ]
      end = pos
    }
    if (addPackages && missing.length > 0) {
      const preamble = preambleChange(view.state.doc.toString(), missing)
      if (preamble) changes.push(preamble)
    }
    const changeSet = view.state.changes(changes)
    view.dispatch({
      changes: changeSet,
      selection: EditorSelection.cursor(changeSet.mapPos(end, 1)),
      effects: closeTexGpt.of(null),
      userEvent: 'input.ai-texgpt',
      annotations: aiEdit.of(true),
      scrollIntoView: true,
    })
    view.focus()
  }

  const canAddPackages = useMemo(
    () =>
      current?.kind === 'latex' &&
      current.packages.length > 0 &&
      preambleChange(state.doc.toString(), current.packages) !== null,
    [state.doc, current]
  )

  if (!field) return null

  const generator = run?.generator ?? null
  const primaryPlan = planFor('primary', field)
  const secondaryPlan = planFor('secondary', field)
  const stale = primaryPlan?.range ? isStale(state, primaryPlan.range) : false
  const titleOptions =
    generator === 'title' && current?.kind === 'options' ? current.options : null
  const code =
    current && current.kind !== 'answer' && !titleOptions
      ? (primaryPlan?.text ?? null)
      : null
  const blockLabels: Record<GeneratorId, string> = {
    title: t('ai_assist_texgpt_replace_title', 'Replace title'),
    abstract: t('ai_assist_texgpt_replace_abstract', 'Replace abstract'),
    keywords: t('ai_assist_texgpt_replace_keywords', 'Replace keywords'),
  }
  const answer = current?.kind === 'answer'
  const primaryLabel = answer
    ? null
    : generator && field.block
      ? blockLabels[generator]
      : replacing && !generator
        ? t('ai_assist_writing_tools_replace', 'Replace')
        : t('ai_assist_texgpt_insert', 'Insert')
  const secondaryLabel = answer
    ? null
    : generator
      ? field.block
        ? t('ai_assist_texgpt_insert_at_cursor', 'Insert at cursor')
        : null
      : replacing
        ? t('ai_assist_texgpt_insert_below', 'Insert below')
        : null
  const primaryDisabled =
    streaming || phase.name !== 'ready' || !primaryPlan || stale
  const placeholder =
    run && current
      ? t('ai_assist_texgpt_follow_up', 'Ask for changes, e.g. add a caption')
      : replacing
        ? t('ai_assist_texgpt_placeholder_selection', 'Ask TeXGPT to edit the selection…')
        : t('ai_assist_texgpt_placeholder', 'Ask TeXGPT for help with anything')

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (streaming) {
        stop()
        return
      }
      close()
      view.focus()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !primaryDisabled) {
      event.preventDefault()
      apply('primary')
    }
  }

  const focusList = () => {
    const item = popupRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"], [role="radio"]'
    )
    item?.focus()
    return Boolean(item)
  }


  const toggleDiff = () => {
    const next = !showDiff
    setShowDiff(next)
    writeWritingToolsPreferences({ ...readWritingToolsPreferences(), showDiff: next })
    if (target?.mode === 'replace' && run && versions.length > 0) {
      saveTexGptHistory({
        kind: 'texgpt',
        originalText: target.original,
        run,
        versions,
        index,
        choice,
        durationMs,
        showDiff: next,
        addPackages,
        timestamp: Date.now(),
      })
    }
  }

  return createPortal(
    <div
      ref={popupRef}
      className={classNames('ai-texgpt-popup', {
        'has-result': Boolean(run || writing),
      })}
      role="dialog"
      aria-label="TeXGPT"
      style={
        position
          ? {
              top: position.top,
              left: position.left,
              width: run || writing ? position.width : undefined,
              maxHeight: `calc(100vh - ${position.top + VIEWPORT_MARGIN}px)`,
            }
          : { visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      {writing && field.target.mode === 'replace' ? (
        <WritingToolsPanel
          key={writing.id}
          session={{
            id: writing.id,
            from: field.target.from,
            to: field.target.to,
            original: field.target.original,
            action: writing.action,
            targetLanguage: writing.targetLanguage,
          }}
          embedded={{
            width: position?.width ?? POPUP_MAX_WIDTH,
            onBack: () => setWriting(null),
            onClose: close,
            onRestart: restartWriting,
          }}
        />
      ) : run ? (
        <TexGptResult
          title={run.title}
          phase={phase}
          versions={versions}
          index={index}
          onIndex={next => {
            setIndex(next)
            setChoice(0)
            setPhase({ name: 'ready' })
            if (target?.mode === 'replace' && run) {
              saveTexGptHistory({
                kind: 'texgpt',
                originalText: target.original,
                run,
                versions,
                index: next,
                choice: 0,
                durationMs,
                showDiff,
                addPackages,
                timestamp: Date.now(),
              })
            }
          }}
          code={code}
          original={primaryPlan?.range && code !== null ? primaryPlan.range.original : null}
          showDiff={showDiff}
          onToggleDiff={toggleDiff}
          options={titleOptions}
          choice={choice}
          onChoose={chosen => {
            setChoice(chosen)
            if (target?.mode === 'replace' && run && versions.length > 0) {
              saveTexGptHistory({
                kind: 'texgpt',
                originalText: target.original,
                run,
                versions,
                index,
                choice: chosen,
                durationMs,
                showDiff,
                addPackages,
                timestamp: Date.now(),
              })
            }
          }}
          onChooseAndApply={chosen => {
            setChoice(chosen)
            apply('primary', chosen)
          }}
          warnings={current?.kind === 'latex' ? current.warnings : []}
          missingPackages={missing}
          canAddPackages={canAddPackages}
          addPackages={addPackages}
          onAddPackages={nextAdd => {
            setAddPackages(nextAdd)
            if (target?.mode === 'replace' && run && versions.length > 0) {
              saveTexGptHistory({
                kind: 'texgpt',
                originalText: target.original,
                run,
                versions,
                index,
                choice,
                durationMs,
                showDiff,
                addPackages: nextAdd,
                timestamp: Date.now(),
              })
            }
          }}
          note={
            partial && generator
              ? t('ai_assist_texgpt_open_file_only', 'Only the open file was read.')
              : null
          }
          stale={stale}
          primaryLabel={primaryLabel}
          primaryDisabled={primaryDisabled}
          onPrimary={() => apply('primary')}
          secondaryLabel={secondaryLabel}
          secondaryDisabled={streaming || phase.name !== 'ready' || !secondaryPlan}
          onSecondary={() => apply('secondary')}
          copyText={
            current?.kind === 'answer' ? current.text : (primaryPlan?.text ?? null)
          }
          durationMs={durationMs ?? undefined}
          onRetry={retry}
          onCancel={close}
          onBack={back}
          onConsent={allow}
          icon={
            generator ? (
              <MaterialIcon type={GENERATOR_ICONS[generator]} />
            ) : (
              // TeXGPT's own icon, as on its toolbar button and chat bar
              <MaterialIcon type="smart_toy" unfilled />
            )
          }
          // A tool's result always ends unlike its stream (chips become
          // \keywords{…}, code becomes the diff); a typed prompt's only in a diff
          reveal={
            generator !== null ||
            (code !== null && primaryPlan?.range != null && showDiff)
          }
          // The chat bar belongs to a typed prompt; a chosen tool is its own card
          followUp={
            generator ? null : (
              <TexGptPromptBar
                inputRef={promptInputRef}
                value={prompt}
                placeholder={placeholder}
                running={streaming}
                onChange={setPrompt}
                onSend={send}
                onStop={stop}
                onArrowDown={focusList}
              />
            )
          }
        />
      ) : (
        <>
          <TexGptPromptBar
            inputRef={promptInputRef}
            value={prompt}
            placeholder={placeholder}
            running={streaming}
            onChange={setPrompt}
            onSend={send}
            onStop={stop}
            onArrowDown={focusList}
          />
          {replacing ? (
            <WritingToolsMenu
              inline
              actions={menu.actions}
              notice={menu.notice}
              onChoose={chooseWritingTool}
              onClose={close}
            />
          ) : (
            <GeneratorMenu
              onChoose={runGenerator}
              onCustomPrompt={() => {
                close()
                openAiChat()
              }}
            />
          )}
        </>
      )}
    </div>,
    document.body
  )
}
