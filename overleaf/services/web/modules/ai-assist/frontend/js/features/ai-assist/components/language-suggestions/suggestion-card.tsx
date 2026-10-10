import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import classNames from 'classnames'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { displayEdit, editKind, type MaskedEdit } from '../../language-suggestions/edits'
import {
  UnitSuggestions,
  visibleEdits,
} from '../../language-suggestions/state'
import {
  readWritingToolsPreferences,
  writeWritingToolsPreferences,
} from '../../writing-tools/preferences'
import '../../../../../stylesheets/ai-assist.scss'

/** A placeholder's LaTeX, short enough to sit inside a sentence. */
export function shortLatex(source: string): string {
  const latex = source.trim()
  if (latex.length <= 16) return latex
  if (latex.startsWith('$')) return '$…$'
  if (latex.startsWith('\\(')) return '\\(…\\)'
  const command = latex.match(/^\\[A-Za-z@]+\*?/)
  return command ? `${command[0]}{…}` : `${latex.slice(0, 12)}…`
}

function editLabel(edit: MaskedEdit): string {
  if (!edit.original) return `Insert "${edit.insert}"`
  if (!edit.insert) return `Delete "${edit.original}"`
  return `Change "${edit.original}" to "${edit.insert}"`
}

type CardActions = {
  /** Applies `accept` and drops `keep`, the changes the author kept their text for. */
  onAccept: (accept: number[], keep: number[]) => void
  onReject: (indexes: number[]) => void
  onBlock: (index: number) => void
  onActivate: (index: number) => void
  onClose: () => void
}

/**
 * One change, toggled between the suggestion (old struck, new in bold) and
 * the author's text (new struck). The pointer shows what a click switches
 * to: a red cross to keep your text, a green tick to take the suggestion.
 * Nothing is written until Accept or Reject.
 */
function Change({
  edit,
  taken,
  active,
  inert,
  onToggle,
  onHover,
}: {
  edit: MaskedEdit
  taken: boolean
  active: boolean
  inert: boolean
  onToggle: () => void
  onHover: () => void
}) {
  const label = taken ? 'Click to keep your text' : 'Click to accept this suggestion'
  const original = edit.original ? (
    taken ? (
      <del>{edit.original}</del>
    ) : (
      <span className="ai-language-suggestion-kept">{edit.original}</span>
    )
  ) : null
  const insert = edit.insert ? (
    taken ? (
      <ins>{edit.insert}</ins>
    ) : (
      <del className="ai-language-suggestion-dropped">{edit.insert}</del>
    )
  ) : null
  const onKeyDown = (event: KeyboardEvent) => {
    if (inert || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onToggle()
  }
  // A span, not a <button>: a button is one unbreakable box, so a long
  // change could not wrap with the sentence
  return (
    <span
      role="button"
      tabIndex={inert ? -1 : 0}
      className={classNames('ai-language-suggestion-change', `ai-language-suggestion-change-${editKind(edit)}`, {
        active,
        'ai-language-suggestion-change-taken': taken,
        'ai-language-suggestion-change-kept': !taken,
      })}
      aria-pressed={taken}
      aria-disabled={inert || undefined}
      aria-label={`${editLabel(edit)}: ${label.toLowerCase()}`}
      title={label}
      onClick={inert ? undefined : onToggle}
      onKeyDown={onKeyDown}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      {original}
      {insert}
    </span>
  )
}

/** The sentence: plain text, the author's LaTeX shortened, each change inline. */
function Sentence({
  unit,
  activeIndex,
  showDiff,
  inert,
  kept,
  onToggle,
  onHover,
}: {
  unit: UnitSuggestions
  activeIndex: number | undefined
  showDiff: boolean
  inert: boolean
  kept: Set<number>
  onToggle: (index: number) => void
  onHover: (index: number) => void
}) {
  const { masked } = unit
  const edits = visibleEdits(unit).sort(
    (a, b) => a.edit.from - b.edit.from || a.edit.to - b.edit.to
  )
  const parts: ReactNode[] = []

  const pushPlain = (from: number, to: number) => {
    let i = from
    while (i < to) {
      const owner = masked.owners[i]
      let j = i
      if (owner >= 0) {
        while (j < to && masked.owners[j] === owner) j++
        parts.push(
          <code key={`p${i}`} className="ai-language-suggestion-latex">
            {shortLatex(masked.placeholders[owner].source)}
          </code>
        )
      } else {
        while (j < to && masked.owners[j] < 0) j++
        parts.push(
          <span key={`t${i}`} className="ai-language-suggestion-plain-text">
            {masked.text.slice(i, j)}
          </span>
        )
      }
      i = j
    }
  }

  let position = 0
  edits.forEach(({ index, edit: raw }, k) => {
    if (raw.from < position) return
    // Punctuation is shown with its word: a lone comma is too small to read
    const next = edits.slice(k + 1).find(other => other.edit.from >= raw.to)
    const edit = displayEdit(masked, raw, position, next?.edit.from)
    pushPlain(position, edit.from)
    position = edit.to
    const taken = !kept.has(index)

    if (!showDiff) {
      // Preview: the sentence as Accept would write it
      const text = taken ? edit.insert : edit.original
      if (text) {
        parts.push(
          <span
            key={`e${index}`}
            className={classNames('ai-language-suggestion-preview-text', {
              'ai-language-suggestion-preview-text-taken': taken,
            })}
          >
            {text}
          </span>
        )
      }
      return
    }

    parts.push(
      <Change
        key={`e${index}`}
        edit={edit}
        taken={taken}
        active={index === activeIndex}
        inert={inert}
        onToggle={() => onToggle(index)}
        onHover={() => onHover(index)}
      />
    )
  })
  pushPlain(position, masked.text.length)
  return <>{parts}</>
}

export function SuggestionCard({
  unit,
  active,
  pinned: controlledPinned,
  preview = false,
  onTogglePin,
  ...actions
}: {
  unit: UnitSuggestions
  active: number | null
  pinned?: boolean
  preview?: boolean
  onTogglePin?: () => void
} & CardActions) {
  const [showDiff, setShowDiff] = useState(
    () => preview || readWritingToolsPreferences().showDiff
  )
  const [internalPinned, setInternalPinned] = useState(false)
  const pinned = controlledPinned !== undefined ? controlledPinned : internalPinned
  const togglePin = useCallback(() => {
    if (onTogglePin) {
      onTogglePin()
    } else {
      setInternalPinned(p => !p)
    }
  }, [onTogglePin])
  const [hovered, setHovered] = useState<number | null>(null)
  /** Changes the author switched back to their own text. */
  const [kept, setKept] = useState<Set<number>>(() => new Set())
  const cardRef = useRef<HTMLDivElement>(null)
  const indexes = visibleEdits(unit).map(visible => visible.index)
  const current = hovered ?? active
  const activeIndex =
    current !== null && indexes.includes(current) ? current : indexes[0]
  const taken = indexes.filter(index => !kept.has(index))
  const keep = indexes.filter(index => kept.has(index))
  const accept = () => {
    if (taken.length > 0) actions.onAccept(taken, keep)
  }

  const toggle = useCallback((index: number) => {
    setKept(previous => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  useEffect(() => {
    if (!preview) cardRef.current?.focus({ preventScroll: true })
  }, [preview])

  const toggleDiff = useCallback(() => {
    const next = !showDiff
    setShowDiff(next)
    if (!preview) {
      writeWritingToolsPreferences({ ...readWritingToolsPreferences(), showDiff: next })
    }
  }, [showDiff, preview])

  const onKeyDown = (event: KeyboardEvent) => {
    if (preview) return
    if (event.key === 'Enter') {
      // On a focused button Enter is that button's click
      if ((event.target as HTMLElement).closest('button, [role="button"]')) return
      event.preventDefault()
      accept()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions.onClose()
    }
  }

  return (
    <div
      ref={cardRef}
      className={classNames('ai-language-suggestion-card', {
        'ai-language-suggestion-card-preview': preview,
        'ai-language-suggestion-card-pinned': pinned,
      })}
      tabIndex={preview ? undefined : -1}
      aria-hidden={preview ? 'true' : undefined}
      onKeyDown={onKeyDown}
      data-testid={preview ? 'language-suggestion-preview' : 'language-suggestion-card'}
    >
      <div
        className={classNames('ai-language-suggestion-card-text', {
          'ai-language-suggestion-card-text-diff': showDiff,
        })}
      >
        <Sentence
          unit={unit}
          activeIndex={activeIndex}
          showDiff={showDiff}
          inert={false}
          kept={kept}
          onToggle={toggle}
          onHover={setHovered}
        />
      </div>
      <div className="ai-language-suggestion-card-footer">
        <OLTooltip
          id="language-suggestion-diff"
          description={showDiff ? 'Preview the result' : 'Show changes'}
          overlayProps={{ placement: 'bottom' }}
        >
          <OLIconButton
            variant="ghost"
            size="sm"
            icon="strikethrough_s"
            active={showDiff}
            accessibilityLabel="Show changes"
            onClick={toggleDiff}
          />
        </OLTooltip>
        <OLTooltip
          id="language-suggestion-pin"
          description={
            pinned
              ? 'Unpin the card to show it near the edits'
              : 'Pin the card to keep its size and position'
          }
          overlayProps={{ placement: 'bottom' }}
        >
          <OLIconButton
            variant="ghost"
            size="sm"
            icon="push_pin"
            active={pinned}
            unfilled={!pinned}
            accessibilityLabel={pinned ? 'Unpin the card' : 'Pin the card'}
            disabled={preview}
            onClick={togglePin}
          />
        </OLTooltip>
        <div className="flex-grow-1" />
        <OLButton
          variant="primary"
          size="sm"
          disabled={taken.length === 0}
          onClick={accept}
        >
          Accept{' '}
          <OLBadge bg="light" text="dark" className="ai-language-suggestion-count">
            {taken.length}
          </OLBadge>
        </OLButton>
        <OLButton
          variant="secondary"
          size="sm"
          onClick={() => actions.onReject(indexes)}
        >
          Reject{' '}
          <OLBadge bg="light" text="dark" className="ai-language-suggestion-count">
            {indexes.length}
          </OLBadge>
        </OLButton>
        <OLTooltip
          id="language-suggestion-block"
          description="Block this suggestion"
          overlayProps={{ placement: 'bottom' }}
        >
          <OLIconButton
            variant="ghost"
            size="sm"
            icon="block"
            accessibilityLabel="Block this suggestion"
            onClick={() => {
              if (activeIndex !== undefined) actions.onBlock(activeIndex)
            }}
          />
        </OLTooltip>
      </div>
    </div>
  )
}
