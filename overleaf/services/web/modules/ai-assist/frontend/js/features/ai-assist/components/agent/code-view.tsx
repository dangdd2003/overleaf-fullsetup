import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'

const NUMBERED_LINE = /^(\d+):\s?(.*)$/

interface CodeViewProps {
  lines?: string[]
  startLine?: number
  onLineClick?: (line: number) => void
}

export default function CodeView({
  lines,
  startLine = 1,
  onLineClick,
}: CodeViewProps) {
  const { editorStyle, gutterStyle, isDark } = useEditorThemeStyles()

  const rawLines = Array.isArray(lines) ? lines : []

  const safeStartLine =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? startLine
      : 1

  return (
    <div
      className={`cm-editor cm-editor-preview ${
        isDark ? 'overall-theme-dark' : 'overall-theme-light'
      } ai-suggest-code-diff`}
      style={editorStyle}
    >
      <div className="cm-scroller">
        <div className="cm-content">
          {rawLines.map((line, index) => {
            const match = line.match(NUMBERED_LINE)
            const lineNo = match ? parseInt(match[1], 10) : safeStartLine + index
            const codeText = match ? match[2] : line

            return (
              <div key={index} className="diff-line diff-line-context">
                <span
                  role={onLineClick ? 'button' : undefined}
                  tabIndex={onLineClick ? 0 : undefined}
                  className={`diff-gutter ${
                    onLineClick ? 'diff-gutter-clickable' : ''
                  }`}
                  style={gutterStyle}
                  onClick={onLineClick ? () => onLineClick(lineNo) : undefined}
                  onKeyDown={
                    onLineClick
                      ? e => e.key === 'Enter' && onLineClick(lineNo)
                      : undefined
                  }
                  title={onLineClick ? `Jump to line ${lineNo}` : undefined}
                >
                  {lineNo}
                </span>
                <span className="diff-content">{codeText}</span>
                {match && <span style={{ display: 'none' }}>{line}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
