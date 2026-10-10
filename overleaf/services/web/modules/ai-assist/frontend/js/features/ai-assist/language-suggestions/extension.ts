import { Extension, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, ViewUpdate } from '@codemirror/view'
import {
  addLearnedWordEffect,
  removeLearnedWordEffect,
} from '@/features/source-editor/extensions/spelling/learned-words'
import {
  hasConsented,
  LANGUAGE_SUGGESTIONS_CHANGED_EVENT,
  loadComposerPreferences,
} from '../provider-store'
import { isLanguageSuggestionsAvailable } from './availability'
import { resolveModel } from './model-choice'
import { readLanguageSuggestionsPreferences, wantsStyle } from './preferences'
import { onPageAttention, pageAttended } from '../inline-context/page-attention'
import { backgroundHold, onModelReleased } from '../inline-context/model-priority'
import { EditPositions, Scheduler } from './scheduler'
import { projectSharedResults } from './shared'
import { TabShare } from './tab-share'
import {
  closeCard,
  languageSuggestionsField,
  openCard,
  refreshFilters,
  setStatus,
  setUnitResults,
} from './state'

/** What, in the preferences, changes what gets checked (the blocked list does not). */
function checkingKey(): string {
  const preferences = readLanguageSuggestionsPreferences()
  const { enabled, englishVariant, model } = preferences
  // All and Style ask for the same check; the filter tells them apart
  return JSON.stringify([enabled, englishVariant, model, wantsStyle(preferences)])
}

const languageSuggestionsPlugin = ViewPlugin.fromClass(
  class {
    scheduler: Scheduler
    private lastKey = checkingKey()
    /** Where the author and collaborators last edited, mapped through every change. */
    private edits: EditPositions = { local: null, remote: null }

    private onPreferences = () => {
      this.view.dispatch({ effects: refreshFilters.of(null) })
      const key = checkingKey()
      if (key !== this.lastKey) {
        this.lastKey = key
        this.scheduler.reset()
      }
    }

    private onProvider = () => this.scheduler.reset()

    private destroyed = false

    private onLearnedWord = () => {
      if (this.destroyed || (this.view as any).isDestroyed) return
      this.view.dispatch({ effects: refreshFilters.of(null) })
    }

    private stopWatchingPage: () => void
    private stopResuming: () => void
    private tabs: TabShare

    constructor(readonly view: EditorView) {
      // Results another tab checked arrive here; what it let go of is picked up
      this.tabs = new TabShare((key, entry) => {
        if (key && entry) this.scheduler.adopt(key, entry)
        this.scheduler.schedule(0)
      })
      this.scheduler = new Scheduler({
        shared: projectSharedResults(),
        tabs: this.tabs,
        getDoc: () => view.state.doc.toString(),
        getViewport: () => view.viewport,
        getCursor: () => view.state.selection.main.head,
        getEditPositions: () => this.edits,
        isActive: () =>
          !view.state.readOnly &&
          hasConsented() &&
          readLanguageSuggestionsPreferences().enabled,
        isAttended: pageAttended,
        resolve: () => {
          const preferences = readLanguageSuggestionsPreferences()
          const model = resolveModel(preferences.model)
          return model
            ? { model, variant: preferences.englishVariant, style: wantsStyle(preferences) }
            : null
        },
        holdFor: backgroundHold,
        deliver: units => view.dispatch({ effects: setUnitResults.of(units) }),
        onStatus: status => view.dispatch({ effects: setStatus.of(status) }),
      })
      window.addEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, this.onPreferences)
      window.addEventListener('aiAssist:providerChanged', this.onProvider)
      window.addEventListener('aiAssist:fastProviderChanged', this.onProvider)
      window.addEventListener('editor:remove-learned-word', this.onLearnedWord)
      this.stopWatchingPage = onPageAttention(attended => {
        if (attended) {
          this.scheduler.schedule()
        } else {
          // Away from the page: the sentence being edited is handed over on return
          this.edits = { ...this.edits, local: null }
        }
      })
      // A completion on the same server went first (holdFor): carry on after it
      this.stopResuming = onModelReleased(() => this.scheduler.schedule())
      // The account's choices, for a browser that has none yet; it fires the
      // changed event when it brings language suggestions settings
      loadComposerPreferences()
      this.scheduler.schedule(0)
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        let local = false
        for (const tr of update.transactions) {
          if (!tr.docChanged) continue
          const remote = Boolean(tr.annotation(Transaction.remote))
          const map = (pos: number | null) => (pos === null ? null : tr.changes.mapPos(pos))
          this.edits = { local: map(this.edits.local), remote: map(this.edits.remote) }
          let end: number | null = null
          let lineBreak = false
          tr.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
            end = toB
            if (inserted.toString().includes('\n')) lineBreak = true
          })
          if (remote) this.edits.remote = end
          else {
            // Enter ends the author's work on the sentence, like moving away
            this.edits.local = lineBreak && !tr.isUserEvent('input.paste') ? null : end
            local = true
          }
        }
        this.scheduler.noteEdit({ remote: !local })
      } else if (update.selectionSet) {
        // The cursor may have left the sentence being edited
        this.scheduler.schedule()
      }
      if (update.focusChanged && !update.view.hasFocus && this.edits.local !== null) {
        // Leaving the editor hands over the sentence being edited
        this.edits = { ...this.edits, local: null }
        this.scheduler.schedule()
      }
      if (update.startState.readOnly !== update.state.readOnly) {
        this.scheduler.schedule(0)
      }
      const learned = update.transactions.some(tr =>
        tr.effects.some(
          effect => effect.is(addLearnedWordEffect) || effect.is(removeLearnedWordEffect)
        )
      )
      // No dispatch inside an update
      if (learned) queueMicrotask(this.onLearnedWord)
    }

    destroy() {
      this.destroyed = true
      this.scheduler.destroy()
      this.tabs.close()
      this.stopWatchingPage()
      this.stopResuming()
      window.removeEventListener(LANGUAGE_SUGGESTIONS_CHANGED_EVENT, this.onPreferences)
      window.removeEventListener('aiAssist:providerChanged', this.onProvider)
      window.removeEventListener('aiAssist:fastProviderChanged', this.onProvider)
      window.removeEventListener('editor:remove-learned-word', this.onLearnedWord)
    }
  }
)

/** A left click on an underline opens its card; the cursor moves as usual. */
const openOnClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return false
    }
    const target = (event.target as HTMLElement | null)?.closest?.('[data-language-suggestion]')
    if (!target) return false
    const [from, edit] = (target.getAttribute('data-language-suggestion') ?? '')
      .split(':')
      .map(Number)
    const unit = view.state
      .field(languageSuggestionsField, false)
      ?.units.find(u => u.from === from)
    if (!unit) return false
    view.dispatch({ effects: openCard.of({ hash: unit.hash, from, edit }) })
    return false
  },
})

const languageSuggestionsTheme = EditorView.baseTheme({
  '.ol-language-suggestion': {
    textDecorationLine: 'underline',
    textDecorationThickness: '2px',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  // Corrections in orange, style in blue
  '&light .ol-language-suggestion': {
    textDecorationColor: '#e8710a',
  },
  '&dark .ol-language-suggestion': {
    textDecorationColor: '#fb923c',
  },
  '&light .ol-language-suggestion-style': {
    textDecorationColor: 'var(--blue-40, #3b82f6)',
  },
  '&dark .ol-language-suggestion-style': {
    textDecorationColor: 'var(--blue-30, #60a5fa)',
  },
  '&light .ol-language-suggestion-active': {
    backgroundColor: 'rgba(232, 113, 10, 0.16)',
  },
  '&dark .ol-language-suggestion-active': {
    backgroundColor: 'rgba(251, 146, 60, 0.2)',
  },
  '&light .ol-language-suggestion-style.ol-language-suggestion-active': {
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
  },
  '&dark .ol-language-suggestion-style.ol-language-suggestion-active': {
    backgroundColor: 'rgba(96, 165, 250, 0.2)',
  },
  '.ol-language-suggestion-card-container.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
})

export function languageSuggestionsExtension(): Extension {
  return [
    languageSuggestionsField,
    languageSuggestionsPlugin,
    openOnClick,
    languageSuggestionsTheme,
    Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: view => {
            if (!view.state.field(languageSuggestionsField, false)?.card) return false
            view.dispatch({ effects: closeCard.of(null) })
            return true
          },
        },
      ])
    ),
  ]
}

/** Loaded by the editor through `sourceEditorExtensions`. */
export const extension = (): Extension =>
  isLanguageSuggestionsAvailable() ? languageSuggestionsExtension() : []
