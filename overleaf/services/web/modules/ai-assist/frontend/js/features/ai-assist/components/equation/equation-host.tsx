import { useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { getTooltip } from '@codemirror/view'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { MetadataContext } from '@/features/ide-react/context/metadata-context'
import { AgentMessage } from '../../providers/types'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import { contextAround, documentHints } from '../../writing-tools/prompt'
import { useProjectSource } from '../../texgpt/use-project-source'
import { projectClass, projectPackages } from '../../texgpt/project-text'
import { preambleChange } from '../../texgpt/insert'
import { GeneratorImage, normalizeImage } from '../../generator/image'
import { GeneratorRun, useGeneratorRun } from '../../generator/use-generator-run'
import {
  closeEquation,
  EquationAnchor,
  equationField,
  isPassageStale,
  openEquation,
  startEquationReview,
} from '../../equation/session'
import {
  CursorWhere,
  cursorWhere,
  findPassage,
  lineIndent,
  PassageParts,
  passageMarkup,
} from '../../equation/context'
import {
  equationHabits,
  labelsIn,
  labelStyle,
  prefersParenInline,
} from '../../equation/hints'
import {
  buildEquationFollowUp,
  buildEquationMessage,
  buildEquationRetry,
} from '../../equation/prompt'
import { EquationFacts, EquationResult, generateEquation } from '../../equation/generate'
import { ParsedEquation } from '../../equation/parse-output'
import { applyEquation } from '../../equation/apply'
import { checkMath, documentDefinitions } from '../../equation/math-render'
import { EquationDialog } from './equation-dialog'
import { EquationCard } from './equation-card'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Registered in `sourceEditorComponents`. Renders the "Generate equation"
 * dialog, then the review card in the session's tooltip, and runs the
 * requests in between.
 */
export default function EquationHost() {
  if (!isWritingToolsAvailable()) return null
  return <EquationHostView />
}

/** What one Generate fixed besides the prompt and image. */
type EquationExtra = {
  /** The text when Generate was pressed: every position below is in it. */
  doc: string
  where: CursorWhere
  parts: PassageParts
}

export function EquationHostView({
  normalize = normalizeImage,
}: {
  /** Reads and resizes a file; replaced in tests (jsdom has no canvas). */
  normalize?: (file: File) => Promise<GeneratorImage>
} = {}) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const session = state.field(equationField, false) ?? null
  const metadata = useContext(MetadataContext)
  const loadSource = useProjectSource()
  const [applyEdits, setApplyEdits] = useState(true)
  const [addPackages, setAddPackages] = useState(true)
  const definitions = useMemo(() => documentDefinitions(state), [state])

  /** The facts and the first message: read once per Generate. */
  const prepare = async ({
    extra,
    prompt,
    image,
  }: GeneratorRun<EquationFacts, EquationExtra>) => {
    const source = await loadSource()
    const loaded = projectPackages(source)
    const docClass = projectClass(source)
    const hints = documentHints(extra.doc)
    const labels = new Set([...(metadata?.labels ?? []), ...labelsIn(extra.doc)])
    const { before, after } = contextAround(extra.doc, extra.parts.from, extra.parts.to)
    const facts: EquationFacts = {
      where: extra.where,
      before: extra.parts.before,
      selection: extra.parts.selection,
      after: extra.parts.after,
      indent: lineIndent(extra.doc, extra.parts.from + extra.parts.before.length),
      labels,
      parenInline: prefersParenInline(extra.doc),
      loaded,
      docClass,
    }
    const content = buildEquationMessage({
      docClass,
      language: hints.language,
      packages: [...loaded].sort(),
      macros: hints.macros,
      labelStyle: labelStyle(labels),
      habits: equationHabits(extra.doc),
      before,
      after,
      where: extra.where,
      passage: passageMarkup(extra.parts),
      imageAttached: image !== null,
      prompt,
    })
    const messages: AgentMessage[] = [
      image
        ? {
            role: 'user',
            content,
            images: [{ mediaType: image.mediaType, data: image.data }],
          }
        : { role: 'user', content },
    ]
    return { facts, messages }
  }

  const run = useGeneratorRun<EquationFacts, EquationExtra, EquationResult, ParsedEquation>({
    sessionId: session?.id ?? null,
    initialPrompt: () => {
      const opened = view.state.field(equationField, false)
      if (!opened || opened.keepDraft) return null
      return view.state.sliceDoc(opened.anchor.from, opened.anchor.to)
    },
    normalize,
    prepare,
    generate: ({ messages, facts, settings, signal, onProgress }) =>
      generateEquation({
        messages,
        facts,
        settings,
        signal,
        onProgress,
        checkMath: (tex, display) => checkMath(tex, display, definitions),
      }),
    followUpMessage: buildEquationFollowUp,
    retryMessage: versions => buildEquationRetry(versions.map(version => version.wrapped)),
    onVersion: () => {
      setApplyEdits(true)
      setAddPackages(true)
    },
    failedMessage: t('ai_assist_equation_failed', 'The request failed.'),
    close: () => {
      view.dispatch({ effects: closeEquation.of(null) })
      view.focus()
    },
    reopen: () =>
      openEquation(view, {
        anchor: view.state.field(equationField, false)?.anchor,
        keepDraft: true,
      }),
  })

  const current = run.current
  const canAddPackages = useMemo(
    () =>
      Boolean(
        current &&
          current.packages.length > 0 &&
          preambleChange(state.doc.toString(), current.packages) !== null
      ),
    [current, state.doc]
  )

  /** Fixes the passage, opens the card on it and sends the first request. */
  const beginAt = (where: CursorWhere, anchor: EquationAnchor) => {
    const doc = view.state.doc.toString()
    const parts = findPassage(doc, anchor, where)
    const prompt = run.draft.prompt.trim()
    view.dispatch({ effects: startEquationReview.of({ from: parts.from, to: parts.to }) })
    run.begin(prompt || t('ai_assist_equation_from_image', 'From image'), { doc, where, parts })
  }

  const generate = () => {
    const now = view.state.field(equationField, false)
    if (!now) return
    const where = cursorWhere(view.state, now.anchor.from)
    if (where.kind === 'refused') {
      run.setDialogError(t('ai_assist_equation_cannot_here', "Can't insert math here"))
      return
    }
    beginAt(where, now.anchor)
  }

  const retry = () => {
    const now = view.state.field(equationField, false)
    if (!run.run || !now || run.phase.name === 'streaming') return
    if (now.passage && isPassageStale(view.state, now.passage)) {
      // The text changed: start over on what is there now
      const where = cursorWhere(view.state, now.anchor.from)
      if (where.kind !== 'refused') beginAt(where, now.anchor)
      return
    }
    run.regenerate()
  }

  const insert = () => {
    const now = view.state.field(equationField, false)
    if (!now?.passage || !current || run.phase.name !== 'ready') return
    const text = applyEdits ? current.withEdits : current.equationOnly
    const at = text.indexOf(current.wrapped)
    applyEquation(view, now.passage, text, {
      packages: addPackages && canAddPackages ? current.packages : [],
      cursorOffset: at === -1 ? text.length : at + current.wrapped.length,
    })
  }

  if (!session) return null

  if (session.phase === 'dialog') {
    return (
      <EquationDialog
        prompt={run.draft.prompt}
        onPrompt={run.setPrompt}
        image={run.draft.image}
        imageError={run.imageError}
        readingImage={run.readingImage}
        imagesEnabled
        onImageFile={run.onImageFile}
        onRemoveImage={run.removeImage}
        error={run.dialogError}
        onGenerate={generate}
        onCancel={run.discard}
      />
    )
  }

  const tooltipView = session.tooltip ? getTooltip(view, session.tooltip) : null
  if (!tooltipView || !session.passage) return null
  const extra = run.run?.extra
  return createPortal(
    <EquationCard
      key={session.id}
      title={run.run?.title ?? ''}
      imageAttached={Boolean(run.run?.image)}
      phase={run.phase}
      versions={run.versions}
      index={run.index}
      onIndex={run.selectVersion}
      original={session.passage.original}
      math={extra?.where.kind === 'math' ? extra.where.math : undefined}
      definitions={definitions}
      applyEdits={applyEdits}
      onApplyEdits={setApplyEdits}
      canAddPackages={canAddPackages}
      addPackages={addPackages}
      onAddPackages={setAddPackages}
      durationMs={run.durationMs ?? undefined}
      stale={isPassageStale(state, session.passage)}
      followUp={run.followUp}
      onFollowUp={run.setFollowUp}
      onSendFollowUp={run.sendFollowUp}
      onStop={run.stop}
      onRetry={retry}
      onEditPrompt={run.editPrompt}
      onDiscard={run.discard}
      onInsert={insert}
      onConsent={run.allow}
    />,
    tooltipView.dom
  )
}
