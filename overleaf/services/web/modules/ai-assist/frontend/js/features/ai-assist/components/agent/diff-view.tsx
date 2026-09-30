import React, { useMemo } from 'react'
import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'
import {
  canHighlightCode,
  CodeSegment,
  EDITOR_CODE_CLASS,
  highlightCodeLines,
  useEditorHighlightStyle,
} from '../../hooks/use-editor-code-highlight'

const MAX_ROWS = 12

// Word-level diff, not a plain index-aligned character scan: a naive
// left-to-right character comparison can walk straight through a run that
// happens to re-align (e.g. "title" in "title asfsa sec" -> "titlesec" is
// character-identical at the same offset in both strings), which chops the
// highlighted span in the wrong place. Diffing at word granularity treats
// "title" and "titlesec" as different tokens, so the whole changed phrase is
// grouped into one deleted/inserted span instead of being split around a
// coincidental character match.
export function computeInlineDiff(
  original: unknown = '',
  replacement: unknown = ''
) {
  const safeOrig =
    typeof original === 'string' ? original : String(original ?? '')
  const safeRepl =
    typeof replacement === 'string' ? replacement : String(replacement ?? '')
  try {
    const parts = diffWordsWithSpace(safeOrig, safeRepl)

    let i = 0
    let prefix = ''
    while (i < parts.length && !parts[i].added && !parts[i].removed) {
      prefix += parts[i].value
      i++
    }

    let j = parts.length - 1
    let suffix = ''
    while (j >= i && !parts[j].added && !parts[j].removed) {
      suffix = parts[j].value + suffix
      j--
    }

    let origMiddle = ''
    let replMiddle = ''
    for (let k = i; k <= j; k++) {
      const part = parts[k]
      if (part.removed) {
        origMiddle += part.value
      } else if (part.added) {
        replMiddle += part.value
      } else {
        // Unchanged text sandwiched between two changed spans: keep it as
        // context on both sides rather than splitting the mark into pieces.
        origMiddle += part.value
        replMiddle += part.value
      }
    }

    return { prefix, origMiddle, replMiddle, suffix }
  } catch {
    return {
      prefix: '',
      origMiddle: safeOrig,
      replMiddle: safeRepl,
      suffix: '',
    }
  }
}

// Only the part of a line's segments between two character offsets
function sliceSegments(segments: CodeSegment[], from: number, to: number) {
  const out: CodeSegment[] = []
  let pos = 0
  for (const segment of segments) {
    const end = pos + segment.text.length
    if (end > from && pos < to) {
      out.push({
        text: segment.text.slice(Math.max(0, from - pos), to - pos),
        className: segment.className,
      })
    }
    pos = end
  }
  return out
}

function plainLines(text: string): CodeSegment[][] {
  return text.split('\n').map(line => (line ? [{ text: line }] : []))
}

function renderSegments(segments: CodeSegment[] = []) {
  return segments.map((segment, index) =>
    segment.className ? (
      <span key={index} className={segment.className}>
        {segment.text}
      </span>
    ) : (
      <React.Fragment key={index}>{segment.text}</React.Fragment>
    )
  )
}

type RowKind = 'del' | 'ins' | 'context'

const SIGNS: Record<RowKind, string> = { del: '-', ins: '+', context: '' }

export default function DiffView({
  oldText = '',
  newText = '',
  startLine = 1,
  path,
  onLineClick,
  foldLongHunks = false,
}: {
  oldText?: string
  newText?: string
  startLine?: number
  /** The file's name, for highlighting its code the way the editor does. */
  path?: string
  onLineClick?: (line: number) => void
  foldLongHunks?: boolean
}) {
  const { editorStyle, editorTheme, isDark } = useEditorThemeStyles()
  useEditorHighlightStyle(editorTheme)
  const safeOldText =
    typeof oldText === 'string' ? oldText : String(oldText ?? '')
  const safeNewText =
    typeof newText === 'string' ? newText : String(newText ?? '')
  const safeStartLine =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? startLine
      : 1

  const extension = typeof path === 'string' ? path.split('.').pop() : ''
  const highlighted = Boolean(extension && canHighlightCode(extension))
  const oldSegments = useMemo(
    () =>
      highlighted
        ? highlightCodeLines(safeOldText, extension!)!
        : plainLines(safeOldText),
    [safeOldText, extension, highlighted]
  )
  const newSegments = useMemo(
    () =>
      highlighted
        ? highlightCodeLines(safeNewText, extension!)!
        : plainLines(safeNewText),
    [safeNewText, extension, highlighted]
  )

  const renderGutter = (kind: RowKind, lineNo: number) => (
    <span
      role={onLineClick ? 'button' : undefined}
      tabIndex={onLineClick ? 0 : undefined}
      className={`diff-gutter ${onLineClick ? 'diff-gutter-clickable' : ''}`}
      onClick={onLineClick ? () => onLineClick(lineNo) : undefined}
      onKeyDown={
        onLineClick ? e => e.key === 'Enter' && onLineClick(lineNo) : undefined
      }
      title={onLineClick ? `Jump to line ${lineNo}` : undefined}
    >
      <span className="diff-line-no">{lineNo}</span>
      <span className="diff-sign" aria-hidden="true">
        {SIGNS[kind]}
      </span>
    </span>
  )

  // The row keeps diff-del/diff-ins so a whole changed line can be found as one
  const renderRow = (
    key: string,
    kind: RowKind,
    lineNo: number,
    content: React.ReactNode
  ) => (
    <div
      key={key}
      className={`diff-line diff-line-${kind}${kind === 'context' ? '' : ` diff-${kind}`}`}
    >
      {renderGutter(kind, lineNo)}
      <span className="diff-content">{content}</span>
    </div>
  )

  const renderContainer = (children: React.ReactNode) => {
    const { backgroundColor: _bg, ...diffStyle } = (editorStyle ||
      {}) as Record<string, any>
    return (
      <div
        className={`cm-editor cm-editor-preview ${
          isDark ? 'overall-theme-dark' : 'overall-theme-light'
        } ai-suggest-code-diff is-diff${highlighted ? ` ${EDITOR_CODE_CLASS}` : ''}`}
        style={
          {
            ...diffStyle,
            backgroundColor: 'transparent',
            // Every row's number column is as wide as the longest number
            '--diff-line-no-chars': String(
              safeStartLine + Math.max(oldSegments.length, newSegments.length)
            ).length,
          } as React.CSSProperties
        }
      >
        <div className="cm-scroller">
          <div className="cm-content">{children}</div>
        </div>
      </div>
    )
  }

  // create_file and the creation branch of EditApprovalCard both pass an empty
  // oldText. ''.split('\n') is [''], which would render a bogus deleted blank
  // line, so creations render as pure insertion.
  if (safeOldText === '') {
    return renderContainer(
      newSegments.map((segments, index) =>
        renderRow(
          String(index),
          'ins',
          safeStartLine + index,
          renderSegments(segments)
        )
      )
    )
  }

  const origLines = safeOldText.split('\n')
  const replLines = safeNewText.split('\n')

  // A one-line change also marks the words that changed within the line
  if (origLines.length === 1 && replLines.length === 1) {
    const diff = computeInlineDiff(origLines[0], replLines[0])
    const renderLine = (
      segments: CodeSegment[],
      length: number,
      middle: string,
      kind: 'del' | 'ins'
    ) => {
      const from = diff.prefix.length
      const to = from + middle.length
      return (
        <>
          {renderSegments(sliceSegments(segments, 0, from))}
          {middle && (
            <mark className={`diff-${kind}`}>
              {renderSegments(sliceSegments(segments, from, to))}
            </mark>
          )}
          {renderSegments(sliceSegments(segments, to, length))}
        </>
      )
    }
    return renderContainer(
      <>
        {renderRow(
          'del',
          'del',
          safeStartLine,
          renderLine(
            oldSegments[0] ?? [],
            origLines[0].length,
            diff.origMiddle,
            'del'
          )
        )}
        {renderRow(
          'ins',
          'ins',
          safeStartLine,
          renderLine(
            newSegments[0] ?? [],
            replLines[0].length,
            diff.replMiddle,
            'ins'
          )
        )}
      </>
    )
  }

  // A trailing newline on both sides is required: diffLines treats a line's
  // newline as part of its identity, so without it the last line of one side
  // never matches the same text mid-string on the other, and the whole block
  // degrades to a full delete plus insert.
  let chunks: Change[]
  try {
    chunks = diffLines(origLines.join('\n') + '\n', replLines.join('\n') + '\n')
  } catch {
    chunks = [
      { value: safeOldText + '\n', removed: true },
      { value: safeNewText + '\n', added: true },
    ]
  }
  let origIndex = 0
  let replIndex = 0
  const rows: React.ReactNode[] = []

  chunks.forEach((chunk, chunkIndex) => {
    const lines = chunk.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    lines.forEach((line: string, idx: number) => {
      if (chunk.removed) {
        rows.push(
          renderRow(
            `del-${chunkIndex}-${idx}`,
            'del',
            safeStartLine + origIndex,
            renderSegments(oldSegments[origIndex] ?? [{ text: line }])
          )
        )
        origIndex++
      } else if (chunk.added) {
        rows.push(
          renderRow(
            `ins-${chunkIndex}-${idx}`,
            'ins',
            safeStartLine + replIndex,
            renderSegments(newSegments[replIndex] ?? [{ text: line }])
          )
        )
        replIndex++
      } else {
        rows.push(
          renderRow(
            `ctx-${chunkIndex}-${idx}`,
            'context',
            safeStartLine + replIndex,
            renderSegments(newSegments[replIndex] ?? [{ text: line }])
          )
        )
        origIndex++
        replIndex++
      }
    })
  })

  // By default, renders the full diff inside the scrollable editor container.
  // When foldLongHunks is explicitly enabled, the middle folds into a summary row.
  if (foldLongHunks && rows.length > MAX_ROWS) {
    const head = rows.slice(0, MAX_ROWS / 2)
    const tail = rows.slice(rows.length - MAX_ROWS / 2)
    const hidden = rows.length - MAX_ROWS
    return renderContainer(
      <>
        {head}
        <div className="diff-line diff-line-fold">
          <span className="diff-gutter" />
          <span className="diff-content">… {hidden} more lines</span>
        </div>
        {tail}
      </>
    )
  }

  return renderContainer(rows)
}
