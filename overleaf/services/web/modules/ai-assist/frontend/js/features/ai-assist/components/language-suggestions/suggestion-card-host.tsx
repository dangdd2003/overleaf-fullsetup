import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorView, getTooltip } from '@codemirror/view'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { blockEdit, rejectEdits, settleEdits } from '../../language-suggestions/apply'
import { isLanguageSuggestionsAvailable } from '../../language-suggestions/availability'
import { OPEN_BLOCKED_SUGGESTIONS_EVENT } from '../../language-suggestions/preferences'
import {
  bringCardToFront,
  CardState,
  closeCard,
  languageSuggestionsField,
  openCard,
  togglePinCard,
  UnitSuggestions,
} from '../../language-suggestions/state'
import { BlockedSuggestionsModal } from './blocked-suggestions-modal'
import { SuggestionCard } from './suggestion-card'

/**
 * Registered in `sourceEditorComponents`. Portals the card into the
 * CodeMirror tooltip the state field provides (so it scrolls and flips with
 * the text), and hosts the blocked-suggestions modal, which outlives the
 * settings modal that opens it.
 */
export default function SuggestionCardHost() {
  if (!isLanguageSuggestionsAvailable()) return null
  return (
    <>
      <CardPortals />
      <BlockedSuggestionsModalHost />
    </>
  )
}

/** Above the editor's other tooltips (CodeMirror puts them at 500). */
const CARD_LAYER = 510

function CardPortals() {
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const value = state.field(languageSuggestionsField, false)
  const cards = value?.cards?.length ? value.cards : value?.card ? [value.card] : []

  useEffect(() => {
    // Capture: runs before the editor's own handler, so a click on another
    // underline closes this card and opens that one. Clicks in any card leave it open.
    const onMouseDown = (event: MouseEvent) => {
      const inCard = (event.target as Element | null)?.closest?.(
        '.ol-language-suggestion-card-container'
      )
      if (!inCard) view.dispatch({ effects: closeCard.of(null) })
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [view])

  if (!value || cards.length === 0) return null

  return (
    <>
      {cards.map(card => {
        const unit = value.units.find(
          u => u.hash === card.hash && u.from === card.from
        )
        const tooltipView = unit && getTooltip(view, card.tooltip)
        if (!unit || !tooltipView) return null
        return createPortal(
          <CardPanel
            key={`${card.hash}:${card.from}`}
            view={view}
            unit={unit}
            card={card}
            active={card.edit}
            container={tooltipView.dom}
          />,
          tooltipView.dom
        )
      })}
    </>
  )
}

function CardPanel({
  view,
  unit,
  card,
  active,
  container,
}: {
  view: EditorView
  unit: UnitSuggestions
  card: CardState
  active: number
  container: HTMLElement
}) {
  const target = { hash: unit.hash, from: unit.from }
  const layer = CARD_LAYER + (card.pinned ? Math.min(card.pinOrder, 900) : 1000)

  useLayoutEffect(() => {
    container.style.zIndex = String(layer)
  }, [container, layer])

  const onActivateCard = useCallback(() => {
    view.dispatch({ effects: bringCardToFront.of(target) })
  }, [view, target])

  const onTogglePin = useCallback(() => {
    view.dispatch({ effects: togglePinCard.of(target) })
  }, [view, target])

  const close = useCallback(() => {
    view.dispatch({ effects: closeCard.of({ hash: unit.hash, from: unit.from }) })
    view.focus()
  }, [view, unit.hash, unit.from])

  return (
    <div onMouseDown={onActivateCard}>
      <SuggestionCard
        unit={unit}
        active={active}
        pinned={card.pinned}
        onTogglePin={onTogglePin}
        onAccept={(accept, keep) => {
          settleEdits(view, unit.hash, unit.from, accept, keep)
          close()
        }}
        onReject={indexes => {
          rejectEdits(view, unit.hash, unit.from, indexes)
          close()
        }}
        onBlock={index => {
          blockEdit(view, unit.hash, unit.from, index)
          close()
        }}
        onActivate={index =>
          view.dispatch({ effects: openCard.of({ ...target, edit: index }) })
        }
        onClose={close}
      />
    </div>
  )
}

function BlockedSuggestionsModalHost() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const open = () => setShow(true)
    window.addEventListener(OPEN_BLOCKED_SUGGESTIONS_EVENT, open)
    return () => window.removeEventListener(OPEN_BLOCKED_SUGGESTIONS_EVENT, open)
  }, [])
  return <BlockedSuggestionsModal show={show} onHide={() => setShow(false)} />
}
