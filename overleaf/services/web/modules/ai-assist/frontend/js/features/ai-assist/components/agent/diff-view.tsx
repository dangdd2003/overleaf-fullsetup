import React from 'react'
import { diffLines, diffWordsWithSpace } from 'diff'
import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'

const MAX_ROWS = 12

// Word-level diff, not a plain index-aligned character scan: a naive
// left-to-right character comparison can walk straight through a run that
// happens to re-align (e.g. "title" in "title asfsa sec" -> "titlesec" is
// character-identical at the same offset in both strings), which chops the
// highlighted span in the wrong place. Diffing at word granularity treats
// "title" and "titlesec" as different tokens, so the whole changed phrase is
// grouped into one deleted/inserted span instead of being split around a
// coincidental character match.
export function computeInlineDiff(original: unknown = '', replacement: unknown = '') {
  const safeOrig = typeof original === 'string' ? original : String(original ?? '')
  const safeRepl = typeof replacement === 'string' ? replacement : String(replacement ?? '')
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
    return { prefix: '', origMiddle: safeOrig, replMiddle: safeRepl, suffix: '' }
  }
}

export default function DiffView({
  oldText = '',
  newText = '',
  startLine = 1,
  onLineClick,
  foldLongHunks = false,
}: {
  oldText?: string
  newText?: string
  startLine?: number
  onLineClick?: (line: number) => void
  foldLongHunks?: boolean
}) {
  const { editorStyle, gutterStyle, isDark } = useEditorThemeStyles()
  const safeOldText = typeof oldText === 'string' ? oldText : String(oldText ?? '')
  const safeNewText = typeof newText === 'string' ? newText : String(newText ?? '')
  const safeStartLine =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? startLine
      : 1

  const renderGutter = (prefix: string, lineNo: number) => (
    <span
      role={onLineClick ? 'button' : undefined}
      tabIndex={onLineClick ? 0 : undefined}
      className={`diff-gutter ${onLineClick ? 'diff-gutter-clickable' : ''}`}
      style={gutterStyle}
      onClick={onLineClick ? () => onLineClick(lineNo) : undefined}
      onKeyDown={
        onLineClick ? e => e.key === 'Enter' && onLineClick(lineNo) : undefined
      }
      title={onLineClick ? `Jump to line ${lineNo}` : undefined}
    >
      {prefix ? `${prefix} ` : ''}{lineNo}
    </span>
  )

  const renderContainer = (children: React.ReactNode) => (
    <div
      className={`cm-editor cm-editor-preview ${
        isDark ? 'overall-theme-dark' : 'overall-theme-light'
      } ai-suggest-code-diff`}
      style={editorStyle}
    >
      <div className="cm-scroller">
        <div className="cm-content">{children}</div>
      </div>
    </div>
  )

  // create_file and the creation branch of EditApprovalCard both pass an empty
  // oldText. ''.split('\n') is [''], which would render a bogus deleted blank
  // line, so creations render as pure insertion.
  if (safeOldText === '') {
    return renderContainer(
      safeNewText.split('\n').map((line, index) => {
        const lineNo = safeStartLine + index
        return (
          <div key={index} className="diff-line diff-line-ins diff-ins">
            {renderGutter('+', lineNo)}
            <span className="diff-content">
              <mark className="diff-ins">{line}</mark>
            </span>
          </div>
        )
      })
    )
  }

  const origLines = safeOldText.split('\n')
  const replLines = safeNewText.split('\n')

  if (origLines.length === 1 && replLines.length === 1) {
    const diff = computeInlineDiff(origLines[0], replLines[0])
    return renderContainer(
      <>
        <div className="diff-line diff-line-del diff-del">
          {renderGutter('-', safeStartLine)}
          <span className="diff-content">
            {diff.prefix}
            {diff.origMiddle && (
              <mark className="diff-del">{diff.origMiddle}</mark>
            )}
            {diff.suffix}
          </span>
        </div>
        <div className="diff-line diff-line-ins diff-ins">
          {renderGutter('+', safeStartLine)}
          <span className="diff-content">
            {diff.prefix}
            {diff.replMiddle && (
              <mark className="diff-ins">{diff.replMiddle}</mark>
            )}
            {diff.suffix}
          </span>
        </div>
      </>
    )
  }

  // A trailing newline on both sides is required: diffLines treats a line's
  // newline as part of its identity, so without it the last line of one side
  // never matches the same text mid-string on the other, and the whole block
  // degrades to a full delete plus insert.
  let chunks: any[] = []
  try {
    chunks = diffLines(origLines.join('\n') + '\n', replLines.join('\n') + '\n')
  } catch {
    chunks = [
      { value: safeOldText + '\n', removed: true },
      { value: safeNewText + '\n', added: true },
    ]
  }
  let origLineNo = safeStartLine
  let replLineNo = safeStartLine
  const rows: React.ReactNode[] = []

  chunks.forEach((chunk, chunkIndex) => {
    const lines = chunk.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    lines.forEach((line: string, idx: number) => {
      if (chunk.removed) {
        const lineNo = origLineNo
        rows.push(
          <div key={`del-${chunkIndex}-${idx}`} className="diff-line diff-line-del diff-del">
            {renderGutter('-', lineNo)}
            <span className="diff-content">
              <mark className="diff-del">{line}</mark>
            </span>
          </div>
        )
        origLineNo++
      } else if (chunk.added) {
        const lineNo = replLineNo
        rows.push(
          <div key={`ins-${chunkIndex}-${idx}`} className="diff-line diff-line-ins diff-ins">
            {renderGutter('+', lineNo)}
            <span className="diff-content">
              <mark className="diff-ins">{line}</mark>
            </span>
          </div>
        )
        replLineNo++
      } else {
        const lineNo = replLineNo
        rows.push(
          <div key={`ctx-${chunkIndex}-${idx}`} className="diff-line diff-line-context">
            {renderGutter('', lineNo)}
            <span className="diff-content">{line}</span>
          </div>
        )
        origLineNo++
        replLineNo++
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
          <span className="diff-gutter" style={gutterStyle} />
          <span className="diff-content">… {hidden} more lines</span>
        </div>
        {tail}
      </>
    )
  }

  return renderContainer(rows)
}
