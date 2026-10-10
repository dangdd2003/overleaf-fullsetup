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
import { flattenDocument, projectClass, projectPackages } from '../../texgpt/project-text'
import { preambleChange } from '../../texgpt/insert'
import { GeneratorImage, normalizeImage } from '../../generator/image'
import { isPassageStale } from '../../generator/session'
import { labelsIn } from '../../generator/labels'
import { applyGenerated } from '../../generator/apply'
import { onlyTabular } from '../../generator/clipboard'
import { GeneratorRun, useGeneratorRun } from '../../generator/use-generator-run'
import { closeTable, openTable, startTableReview, tableField } from '../../table/session'
import {
  BlockRange,
  blockRange,
  InsertWhere,
  SelectionKind,
  selectionKind,
  tableWhere,
} from '../../table/context'
import { tableHabits } from '../../table/hints'
import { buildTableFollowUp, buildTableMessage, buildTableRetry } from '../../table/prompt'
import { generateTable, previewLatex, TableFacts, TableResult } from '../../table/generate'
import { ParsedTable } from '../../table/parse-output'
import { colorTableReady } from '../../table/packages'
import { givenValues } from '../../table/values'
import { TableDialog } from './table-dialog'
import { TableCard } from './table-card'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Registered in `sourceEditorComponents`. Renders the "Generate table"
 * dialog, then the review card in the session's tooltip, and runs the
 * requests in between.
 */
export default function TableHost() {
  if (!isWritingToolsAvailable()) return null
  return <TableHostView />
}

/** What one Generate fixed besides the prompt and image. */
type TableExtra = {
  /** The text when Generate was pressed: every position below is in it. */
  doc: string
  where: InsertWhere
  /** The passage: the anchor, widened over the spaces at a cut. */
  range: BlockRange
  selection: { kind: SelectionKind; text: string } | null
}

export function TableHostView({
  normalize = normalizeImage,
}: {
  /** Reads and resizes a file; replaced in tests (jsdom has no canvas). */
  normalize?: (file: File) => Promise<GeneratorImage>
} = {}) {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const session = state.field(tableField, false) ?? null
  const metadata = useContext(MetadataContext)
  const loadSource = useProjectSource()
  const [addPackages, setAddPackages] = useState(true)

  /** The facts and the first message: read once per Generate. */
  const prepare = async ({ extra, prompt, image }: GeneratorRun<TableFacts, TableExtra>) => {
    const source = await loadSource()
    const loaded = projectPackages(source)
    const docClass = projectClass(source)
    const whole = flattenDocument(source)
    const hints = documentHints(extra.doc)
    const labels = new Set([
      ...(metadata?.labels ?? []),
      ...labelsIn(whole),
      ...labelsIn(extra.doc),
    ])
    const habits = tableHabits(whole, labels, loaded)
    const { before, after } = contextAround(extra.doc, extra.range.from, extra.range.to)
    const selectedLabels = extra.selection?.kind === 'table' ? [...labelsIn(extra.selection.text)] : []
    const facts: TableFacts = {
      where: extra.where,
      habits,
      labels,
      keepLabel: selectedLabels.length === 1 ? selectedLabels[0] : null,
      loaded,
      docClass,
      colorReady: colorTableReady(whole, loaded),
      around: {
        lineBefore: extra.range.lineBefore,
        lineAfter: extra.range.lineAfter,
        indent: extra.range.indent,
      },
      values: givenValues(prompt, extra.selection),
    }
    const content = buildTableMessage({
      docClass,
      language: hints.language,
      packages: [...loaded].sort(),
      macros: hints.macros,
      habits,
      before,
      after,
      where: extra.where,
      selection: extra.selection,
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

  const run = useGeneratorRun<TableFacts, TableExtra, TableResult, ParsedTable>({
    sessionId: session?.id ?? null,
    // A selection is sent as data, never copied into the prompt
    initialPrompt: () => {
      const opened = view.state.field(tableField, false)
      return !opened || opened.keepDraft ? null : ''
    },
    normalize,
    prepare,
    generate: args => generateTable(args),
    followUpMessage: buildTableFollowUp,
    retryMessage: versions => buildTableRetry(versions.map(version => version.latex)),
    onVersion: () => setAddPackages(true),
    errorPhase: error =>
      error?.code === 'outputTruncated'
        ? {
            name: 'error',
            message: t(
              'ai_assist_table_too_long',
              'The table is too long for one reply. Ask for part of it, or choose a model with a larger output limit.'
            ),
          }
        : null,
    failedMessage: t('ai_assist_table_failed', 'The request failed.'),
    close: () => {
      view.dispatch({ effects: closeTable.of(null) })
      view.focus()
    },
    reopen: () =>
      openTable(view, {
        anchor: view.state.field(tableField, false)?.anchor,
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

  const titleFor = (selection: TableExtra['selection'], image: boolean) => {
    const prompt = run.draft.prompt.trim()
    if (prompt && !onlyTabular(prompt)) return prompt
    if (prompt) return t('ai_assist_table_from_data', 'From pasted data')
    if (selection && !image) return t('ai_assist_table_from_selection', 'From selection')
    return t('ai_assist_table_from_image', 'From image')
  }

  /** Checks where the table goes, opens the card there and sends the first request. */
  const beginAt = (anchor: { from: number; to: number }) => {
    const where = tableWhere(view.state, anchor)
    if (where.kind === 'refused') {
      run.setDialogError(
        where.reason === 'table'
          ? t(
              'ai_assist_table_inside_table',
              "Can't insert a table inside a table. Select the whole table to rewrite it."
            )
          : where.reason === 'selection'
            ? t('ai_assist_table_bad_selection', 'Select a whole table or plain text')
            : t('ai_assist_table_cannot_here', "Can't insert a table here")
      )
      return
    }
    const doc = view.state.doc.toString()
    const range = blockRange(doc, anchor)
    const text = doc.slice(anchor.from, anchor.to)
    const selection = text.trim() ? { kind: selectionKind(text), text } : null
    view.dispatch({ effects: startTableReview.of({ from: range.from, to: range.to }) })
    run.begin(titleFor(selection, run.draft.image !== null), { doc, where, range, selection })
  }

  const generate = () => {
    const now = view.state.field(tableField, false)
    if (now) beginAt(now.anchor)
  }

  const retry = () => {
    const now = view.state.field(tableField, false)
    if (!run.run || !now || run.phase.name === 'streaming') return
    if (now.passage && isPassageStale(view.state, now.passage)) {
      // The text changed: start over on what is there now
      beginAt(now.anchor)
      return
    }
    run.regenerate()
  }

  const insert = () => {
    const now = view.state.field(tableField, false)
    if (!now?.passage || !current || run.phase.name !== 'ready') return
    applyGenerated(view, now.passage, current.text, {
      packages: addPackages && canAddPackages ? current.packages : [],
      cursorOffset: current.cursorOffset,
      userEvent: 'input.ai-table',
      close: closeTable.of(null),
    })
  }

  if (!session) return null

  if (session.phase === 'dialog') {
    const selected = view.state.sliceDoc(session.anchor.from, session.anchor.to)
    return (
      <TableDialog
        prompt={run.draft.prompt}
        onPrompt={run.setPrompt}
        image={run.draft.image}
        imageError={run.imageError}
        readingImage={run.readingImage}
        imagesEnabled
        onImageFile={run.onImageFile}
        onRemoveImage={run.removeImage}
        error={run.dialogError}
        selectionLines={selected.trim() ? selected.split('\n').length : 0}
        onGenerate={generate}
        onCancel={run.discard}
      />
    )
  }

  const tooltipView = session.tooltip ? getTooltip(view, session.tooltip) : null
  if (!tooltipView || !session.passage) return null
  const facts = run.run?.facts ?? null
  const streamingCode =
    run.phase.name === 'streaming' && run.phase.reply && facts
      ? previewLatex(run.phase.reply, facts)
      : null
  return createPortal(
    <TableCard
      key={session.id}
      title={run.run?.title ?? ''}
      imageAttached={Boolean(run.run?.image)}
      phase={run.phase}
      versions={run.versions}
      index={run.index}
      onIndex={run.selectVersion}
      original={run.run?.extra.selection ? session.passage.original : ''}
      streamingCode={streamingCode}
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
