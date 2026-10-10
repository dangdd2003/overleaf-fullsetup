import { KeyboardEvent, ReactNode, useMemo } from 'react'
import classNames from 'classnames'
import {
  diffSegments,
  DiffSegment,
  EditUnit,
} from '../../writing-tools/apply'

export type DiffTextProps = {
  original: string
  result: string
  /**
   * Changes the author switched back to their own text. With `onToggle`,
   * each change is a click target, as in the language suggestion card.
   */
  kept?: Set<number>
  onToggle?: (group: number) => void
  /** What one click switches: a phrase, or every change in a sentence. */
  unit?: EditUnit
}

type Chunk = { text: string; className?: string; tag: 'span' | 'del' | 'ins' }

/** Words with their spaces. */
function chunks(text: string): string[] {
  return text.match(/\S+|\s+/g) || (text ? [text] : [])
}

type Change = Extract<DiffSegment, { kind: 'change' }>

function changeLabel(changes: Change[]) {
  const original = changes.map(c => c.original).join(' … ').trim()
  const insert = changes.map(c => c.insert).join(' … ').trim()
  if (!original) return `Insert "${insert}"`
  if (!insert) return `Delete "${original}"`
  return `Change "${original}" to "${insert}"`
}

/**
 * Removed words struck through, added words in bold, the rest as is. The
 * box around it fades in once (`.ai-assist-reveal`), not each word. Toggleable, a taken change shows a red ✗
 * pointer (keep your text) and a kept one a green ✓ (take the suggestion).
 */
export function DiffText({
  original,
  result,
  kept,
  onToggle,
  unit = 'phrase',
}: DiffTextProps) {
  const segments = useMemo(
    () => diffSegments(original, result, unit),
    [original, result, unit]
  )

  const renderChunks = (list: Chunk[], keyPrefix: string): ReactNode[] =>
    list.flatMap((chunk, c) =>
      chunks(chunk.text).map((text, w) => {
        const Tag = chunk.tag
        return (
          <Tag
            key={`${keyPrefix}-${c}-${w}`}
            className={chunk.className}
          >
            {text}
          </Tag>
        )
      })
    )

  const changeChunks = (change: Change, taken: boolean): Chunk[] =>
    taken
      ? [
          { text: change.original, tag: 'del' },
          { text: change.insert, tag: 'ins' },
        ]
      : [
          {
            text: change.original,
            tag: 'span',
            className: 'ai-language-suggestion-kept',
          },
          {
            text: change.insert,
            tag: 'del',
            className: 'ai-language-suggestion-dropped',
          },
        ]

  // One click target per group: its changes and the shared text between them
  const runs: DiffSegment[][] = []
  for (const segment of segments) {
    const last = runs[runs.length - 1]
    if (
      onToggle &&
      segment.group !== undefined &&
      last?.[0].group === segment.group
    ) {
      last.push(segment)
    } else {
      runs.push([segment])
    }
  }

  return (
    <>
      {runs.map((run, index) => {
        const [first] = run
        if (first.kind === 'same' && first.group === undefined) {
          return renderChunks([{ text: first.text, tag: 'span' }], `s${index}`)
        }
        if (!onToggle) {
          return renderChunks(
            first.kind === 'same'
              ? [{ text: first.text, tag: 'span' }]
              : changeChunks(first, true),
            `c${index}`
          )
        }

        const group = first.group as number
        const taken = !kept?.has(group)
        const label = taken
          ? 'Click to keep your text'
          : 'Click to accept this suggestion'
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onToggle(group)
        }
        // A span, not a <button>, so a long phrase wraps with the sentence
        return (
          <span
            key={`c${index}`}
            role="button"
            tabIndex={0}
            className={classNames(
              'ai-language-suggestion-change',
              'ai-writing-tools-change',
              taken
                ? 'ai-language-suggestion-change-taken'
                : 'ai-language-suggestion-change-kept'
            )}
            aria-pressed={taken}
            aria-label={`${changeLabel(
              run.filter((s): s is Change => s.kind === 'change')
            )}: ${label.toLowerCase()}`}
            title={label}
            onClick={() => onToggle(group)}
            onKeyDown={onKeyDown}
          >
            {renderChunks(
              run.flatMap(segment =>
                segment.kind === 'same'
                  ? [{ text: segment.text, tag: 'span' as const }]
                  : changeChunks(segment, taken)
              ),
              `c${index}`
            )}
          </span>
        )
      })}
    </>
  )
}
