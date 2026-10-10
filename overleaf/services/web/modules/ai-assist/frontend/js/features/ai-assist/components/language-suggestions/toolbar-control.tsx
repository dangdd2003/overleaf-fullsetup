import { ReactNode } from 'react'
import classNames from 'classnames'
import { EditorView } from '@codemirror/view'
import { CaretLeft, CaretRight, Check, Warning } from '@phosphor-icons/react'
import MaterialIcon from '@/shared/components/material-icon'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { hasConsented } from '../../provider-store'
import { isLanguageSuggestionsAvailable } from '../../language-suggestions/availability'
import { effectiveSlot } from '../../language-suggestions/model-choice'
import {
  languageSuggestionsField,
  nextSuggestion,
  openCard,
  suggestionCount,
} from '../../language-suggestions/state'
import { useLanguageSuggestionsPreferences } from './use-language-suggestions-preferences'
import '../../../../../stylesheets/ai-assist.scss'

/** Registered in `sourceEditorToolbarEndButtons`: count, state and navigation. */
export default function LanguageSuggestionsToolbarControl() {
  if (!isLanguageSuggestionsAvailable()) return null
  return <ToolbarControl />
}

function openSettings() {
  window.dispatchEvent(new CustomEvent('ui.toggle-settings', { detail: true }))
  window.dispatchEvent(
    new CustomEvent('ui.focus-setting', { detail: 'aiLanguageSuggestions' })
  )
}

/** Keeps the editor's selection when a toolbar button is pressed. */
const keepSelection = (event: React.MouseEvent) => event.preventDefault()

function ToolbarControl() {
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const [preferences] = useLanguageSuggestionsPreferences()
  const value = state.field(languageSuggestionsField, false)
  if (
    !value ||
    !preferences.enabled ||
    state.readOnly ||
    !hasConsented() ||
    !effectiveSlot(preferences.model)
  ) {
    return null
  }

  const count = suggestionCount(value)
  const { status } = value

  const go = (direction: 1 | -1) => {
    const target = nextSuggestion(
      view.state.field(languageSuggestionsField),
      view.state.selection.main.head,
      direction
    )
    if (!target) return
    view.dispatch({
      selection: { anchor: target.from },
      effects: [
        EditorView.scrollIntoView(target.from, { y: 'center' }),
        openCard.of({ hash: target.hash, from: target.unitFrom, edit: target.index }),
      ],
    })
    view.focus()
  }

  let label: string
  let icon: ReactNode
  let onClick: (() => void) | undefined
  const isChecking = status.kind === 'checking'

  if (status.kind === 'error' || status.kind === 'stopped') {
    label = status.message
    icon = <Warning size={15} weight="bold" aria-hidden="true" />
    onClick = openSettings
  } else if (isChecking) {
    const progress = status.kind === 'checking' ? status.progress : undefined
    const done = progress ? `Checking ${progress.checked} / ${progress.total} sentences` : null
    label =
      count > 0
        ? done
          ? `${done}… (${count} found so far)`
          : `Checking… (${count} found so far)`
        : done
          ? `${done}…`
          : 'Checking for language suggestions…'
    icon = <OLSpinner size="sm" />
    onClick = count > 0 ? () => go(1) : undefined
  } else if (count === 0) {
    label = 'No language suggestions'
    icon = <Check size={15} weight="bold" aria-hidden="true" />
  } else {
    label = count === 1 ? '1 language suggestion' : `${count} language suggestions`
    icon = <MaterialIcon type="spellcheck" />
    onClick = () => go(1)
  }
  const showCount =
    count > 0 && status.kind !== 'error' && status.kind !== 'stopped'

  return (
    <div className="ol-editor-toolbar-button-group ai-language-suggestions-toolbar">
      <OLTooltip
        id="toolbar-language-suggestions"
        description={label}
        overlayProps={{ placement: 'bottom' }}
      >
        <button
          type="button"
          className="ol-cm-toolbar-button ai-language-suggestions-toolbar-main"
          aria-label={label}
          aria-disabled={!onClick}
          onMouseDown={keepSelection}
          onClick={onClick}
        >
          <span className="ai-language-suggestions-toolbar-icon">{icon}</span>
          {showCount ? (
            <span
              className={classNames('ai-language-suggestions-toolbar-count', {
                checking: isChecking,
              })}
            >
              {count}
            </span>
          ) : null}
        </button>
      </OLTooltip>
      <OLTooltip
        id="toolbar-language-suggestions-previous"
        description="Previous suggestion"
        overlayProps={{ placement: 'bottom' }}
      >
        <button
          type="button"
          className="ol-cm-toolbar-button ai-language-suggestions-toolbar-nav"
          aria-label="Previous suggestion"
          disabled={count === 0}
          onMouseDown={keepSelection}
          onClick={() => go(-1)}
        >
          <CaretLeft size={14} weight="bold" aria-hidden="true" />
        </button>
      </OLTooltip>
      <OLTooltip
        id="toolbar-language-suggestions-next"
        description="Next suggestion"
        overlayProps={{ placement: 'bottom' }}
      >
        <button
          type="button"
          className="ol-cm-toolbar-button ai-language-suggestions-toolbar-nav"
          aria-label="Next suggestion"
          disabled={count === 0}
          onMouseDown={keepSelection}
          onClick={() => go(1)}
        >
          <CaretRight size={14} weight="bold" aria-hidden="true" />
        </button>
      </OLTooltip>
    </div>
  )
}
