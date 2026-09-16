import React from 'react'
import { useEditorThemeStyles } from '../../hooks/use-editor-theme-styles'

export interface CodeViewProps {
  lines?: string[]
  content?: string
  startLine?: number
  onLineClick?: (line: number) => void
  maxHeight?: number | string
}

export default function CodeView({
  lines,
  content = '',
  startLine = 1,
  onLineClick,
  maxHeight,
}: CodeViewProps) {
  const { editorStyle, gutterStyle, isDark } = useEditorThemeStyles()

  const rawLines = Array.isArray(lines)
    ? lines
    : typeof content === 'string'
    ? content.split('\n')
    : []

  const safeStartLine =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? startLine
      : 1

  return (
    <div
      className={`cm-editor cm-editor-preview ${
        isDark ? 'overall-theme-dark' : 'overall-theme-light'
      } ai-suggest-code-diff`}
      style={{
        ...editorStyle,
        ...(maxHeight ? { maxHeight } : {}),
      }}
    >
      <div className="cm-scroller">
        <div className="cm-content">
          {rawLines.map((line, index) => {
            const match = line.match(/^(\d+):\s?(.*)$/)
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
