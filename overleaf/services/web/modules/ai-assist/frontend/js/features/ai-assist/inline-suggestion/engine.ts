import {
  Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { aiEdit } from '../ai-edit-glow/extension'
import { lastWordBreak } from '../hooks/use-stream-reveal'

/** Who asked: the prompt bar, Shift+Space, or a pause in typing (Automatic). */
export type SuggestionSource = 'prompt' | 'completion' | 'auto'

export type Suggestion = {
  id: number
  source: SuggestionSource
  /** Where the text goes; the cursor stays here while it shows. */
  pos: number
  text: string
  /** How much of `text` is on screen; the rest is revealed word by word. */
  shown: number
  /** What the author typed through: now in the document, gone from `text`. */
  typed: string
  status: 'streaming' | 'ready'
}

export type ShapedText = {
  text: string
  /** Enough has arrived: stop reading and abort the request. */
  stop?: boolean
}

export type SuggestionRequest = {
  source: SuggestionSource
  /** The cursor when the request starts. */
  pos: number
  /** The whole raw reply so far, after every chunk. */
  stream: (signal: AbortSignal) => AsyncIterable<string>
  /** Raw reply → what is shown; `done` once the reply is complete. */
  shape: (raw: string, done: boolean) => ShapedText
  /** Once, when the first non-empty text shows. */
  onFirstText?: () => void
}

export type SuggestionOutcome = {
  status: 'shown' | 'empty' | 'cancelled'
  raw: string
}

/** After the ghost text once it is complete, as in Writefull's Supercomplete. */
export const TAB_HINT = '⇥ Tab'

const showSuggestion = StateEffect.define<{
  id: number
  source: SuggestionSource
  pos: number
}>()
const updateSuggestionText = StateEffect.define<{ id: number; text: string }>()
const markReady = StateEffect.define<{ id: number; text: string }>()
const revealTo = StateEffect.define<{ id: number; shown: number }>()
export const clearSuggestion = StateEffect.define<null>()

/** Matches the popups' `ai-assist-stream-fade`. */
const FADE_MS = 400
/** Words revealed together fade in one after another, this far apart… */
const WORD_STAGGER_MS = 24
/** …but never further behind than this. */
const MAX_STAGGER_MS = 250
/** One word with the spaces around it, or a run of spaces alone. */
const FADE_TOKEN = /\s*\S+\s*|\s+/g

/**
 * What the ghost of a suggestion last painted, with what was typed through
 * in front. CodeMirror redraws widgets (scrolling, other decorations), and
 * typing through trims the ghost; text already painted must not fade again.
 */
let painted: { id: number; full: string } = { id: -1, full: '' }

function commonPrefixLength(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/** Appends `text` to the ghost, each word fading in after the one before. */
function appendFading(ghost: HTMLElement, text: string) {
  let index = 0
  for (const [token] of text.matchAll(FADE_TOKEN)) {
    const span = document.createElement('span')
    span.className = 'ai-inline-suggestion-fade'
    span.style.animationDelay = `${Math.min(index * WORD_STAGGER_MS, MAX_STAGGER_MS)}ms`
    span.textContent = token
    ghost.appendChild(span)
    index++
  }
}

class GhostWidget extends WidgetType {
  constructor(
    readonly id: number,
    /** Typed through: in the document now, not in the ghost. */
    readonly typed: string,
    readonly text: string,
    /** Complete and fully revealed: the Tab hint shows. */
    readonly ready: boolean,
    /** More is coming: the pulse shows after the text. */
    readonly pending: boolean
  ) {
    super()
  }

  eq(other: GhostWidget) {
    return (
      other.id === this.id &&
      other.typed === this.typed &&
      other.text === this.text &&
      other.ready === this.ready &&
      other.pending === this.pending
    )
  }

  toDOM() {
    const ghost = document.createElement('span')
    ghost.className = 'ai-inline-suggestion'
    ghost.setAttribute('aria-hidden', 'true')
    this.paint(ghost)
    return ghost
  }

  /** Keeps the painted words and fades in only the new ones. */
  updateDOM(dom: HTMLElement) {
    this.paint(dom)
    return true
  }

  private paint(ghost: HTMLElement) {
    const full = this.typed + this.text
    const before = painted.id === this.id ? painted.full : ''
    const kept = Math.max(0, commonPrefixLength(before, full) - this.typed.length)
    const onScreen = ghost.dataset.full
    if (
      onScreen !== undefined &&
      onScreen === before &&
      ghost.dataset.typed === this.typed &&
      full.startsWith(onScreen)
    ) {
      // Growing: the words on screen stay as they are
      ghost.querySelector('.ai-inline-suggestion-tail')?.remove()
      appendFading(ghost, full.slice(onScreen.length))
    } else {
      // A new suggestion, a redraw or typed through: only unseen text fades
      ghost.textContent = this.text.slice(0, kept)
      appendFading(ghost, this.text.slice(kept))
    }
    ghost.dataset.full = full
    ghost.dataset.typed = this.typed
    painted = { id: this.id, full }

    if (this.pending) {
      const pulse = document.createElement('span')
      pulse.className = 'ai-inline-suggestion-tail ai-inline-suggestion-pulse'
      ghost.appendChild(pulse)
    } else if (this.ready) {
      const hint = document.createElement('span')
      hint.className = 'ai-inline-suggestion-tail ai-inline-suggestion-hint'
      hint.textContent = TAB_HINT
      ghost.appendChild(hint)
    }
  }

  ignoreEvent() {
    return true
  }
}

/**
 * The full text so far without what the author typed through; null when the
 * text no longer starts with it, or nothing is left of a finished one.
 */
function withText(
  value: Suggestion,
  full: string,
  status: Suggestion['status']
): Suggestion | null {
  if (!full.startsWith(value.typed)) return null
  const text = full.slice(value.typed.length)
  if (status === 'ready' && !text) return null
  // A reply reshaped mid-stream keeps on screen only what still matches
  const shown = Math.min(value.shown, commonPrefixLength(value.text, text))
  return { ...value, text, shown, status }
}

/** The text a local edit inserted at the suggestion when it starts the suggestion; else null. */
function typedThrough(value: Suggestion, tr: Transaction): string | null {
  let changes = 0
  let inserted = ''
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    changes++
    if (fromA === value.pos && toA === value.pos) inserted = text.toString()
  })
  if (changes !== 1 || !inserted || !value.text.startsWith(inserted)) return null
  return inserted
}

/**
 * A collaborator's edit elsewhere only moves the suggestion. A local edit
 * typing its next characters shrinks it; any other local edit, or an edit at
 * it, clears it. It also clears once the cursor is anywhere but a single
 * empty selection at its position.
 */
function follow(value: Suggestion, tr: Transaction): Suggestion | null {
  let next = value
  if (tr.docChanged) {
    if (tr.annotation(Transaction.remote)) {
      if (tr.changes.touchesRange(value.pos)) return null
      next = { ...value, pos: tr.changes.mapPos(value.pos) }
    } else {
      const typed = typedThrough(value, tr)
      if (typed === null) return null
      next = {
        ...value,
        pos: value.pos + typed.length,
        text: value.text.slice(typed.length),
        shown: Math.max(0, value.shown - typed.length),
        typed: value.typed + typed,
      }
      if (next.status === 'ready' && !next.text) return null
    }
  }
  const { selection } = tr.state
  if (
    selection.ranges.length !== 1 ||
    !selection.main.empty ||
    selection.main.head !== next.pos
  ) {
    return null
  }
  return next
}

export const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(clearSuggestion)) return null
      if (effect.is(showSuggestion)) {
        value = { ...effect.value, text: '', shown: 0, typed: '', status: 'streaming' }
      } else if (effect.is(revealTo) && value?.id === effect.value.id) {
        value = { ...value, shown: Math.min(effect.value.shown, value.text.length) }
      } else if (effect.is(updateSuggestionText) && value?.id === effect.value.id) {
        value = withText(value, effect.value.text, 'streaming')
      } else if (effect.is(markReady) && value?.id === effect.value.id) {
        value = withText(value, effect.value.text, 'ready')
      }
    }
    return value ? follow(value, tr) : null
  },
  provide: field =>
    EditorView.decorations.from(field, value => {
      if (!value) return Decoration.none
      const revealed = value.shown >= value.text.length
      const ready = value.status === 'ready' && revealed
      // Before the first word, the pulse alone says a suggestion is coming
      if (!value.text && value.status !== 'streaming') return Decoration.none
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(
            value.id,
            value.typed,
            value.text.slice(0, value.shown),
            ready,
            !ready
          ),
          side: 1,
        }).range(value.pos),
      ])
    }),
})

/**
 * How far behind the stream the reveal runs: the speed is the backlog over
 * this, so a steady stream shows at its own pace and a burst is spread out.
 */
const TARGET_LAG_SEC = 0.35
/** Floors, while streaming and once complete, so the tail never crawls. */
const MIN_LIVE_CHARS_PER_SEC = 30
const MIN_DRAIN_CHARS_PER_SEC = 220
/** How long the reveal takes to speed up to a burst; slowing is immediate. */
const RATE_RISE_SEC = 0.3
/** A run without spaces longer than this is revealed mid-word. */
const MAX_WORD_CHARS = 24

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * Reveals the suggestion a word at a time on animation frames, like the
 * popups' streaming text, instead of in the chunks the network delivers.
 */
const revealPacer = ViewPlugin.fromClass(
  class {
    frame = 0
    last = 0
    budget = 0
    rate = MIN_LIVE_CHARS_PER_SEC
    id = -1

    constructor(readonly view: EditorView) {
      this.schedule()
    }

    update(update: ViewUpdate) {
      if (update.state.field(suggestionField, false) !== update.startState.field(suggestionField, false)) {
        this.schedule()
      }
    }

    schedule() {
      const value = this.view.state.field(suggestionField, false)
      if (!value || value.shown >= value.text.length || this.frame) return
      if (value.id !== this.id) {
        this.id = value.id
        this.last = this.budget = 0
        this.rate = MIN_LIVE_CHARS_PER_SEC
      }
      this.frame = window.requestAnimationFrame(now => {
        this.frame = 0
        this.step(now)
      })
    }

    step(now: number) {
      const value = this.view.state.field(suggestionField, false)
      if (!value || value.id !== this.id) return
      const { text, shown } = value
      const backlog = text.length - shown
      if (backlog <= 0) return
      const done = value.status === 'ready'

      let end: number
      if (prefersReducedMotion()) {
        end = text.length
      } else {
        const dt = this.last ? Math.min(now - this.last, 100) : 16
        this.last = now
        const target = Math.max(
          done ? MIN_DRAIN_CHARS_PER_SEC : MIN_LIVE_CHARS_PER_SEC,
          backlog / TARGET_LAG_SEC
        )
        this.rate =
          target > this.rate
            ? this.rate + (target - this.rate) * (1 - Math.exp(-dt / 1000 / RATE_RISE_SEC))
            : target
        this.budget = Math.min(this.budget + (this.rate * dt) / 1000, backlog)
        const limit = shown + Math.floor(this.budget)
        end = done && limit >= text.length ? text.length : lastWordBreak(text, shown, limit)
        if (end === -1 && limit - shown >= MAX_WORD_CHARS) end = limit
      }

      if (end > shown) {
        this.budget = Math.max(0, this.budget - (end - shown))
        this.view.dispatch({ effects: revealTo.of({ id: value.id, shown: end }) })
      } else {
        this.schedule()
      }
    }

    destroy() {
      if (this.frame) window.cancelAnimationFrame(this.frame)
    }
  }
)

/** One request per suggestion id; aborted as soon as that suggestion goes. */
const controllers = new Map<number, AbortController>()

function abortRequest(id: number) {
  controllers.get(id)?.abort()
  controllers.delete(id)
}

const abortOnClear = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      const before = update.startState.field(suggestionField, false)
      const after = update.state.field(suggestionField, false)
      if (before && before.id !== after?.id) abortRequest(before.id)
    }

    destroy() {
      const current = this.view.state.field(suggestionField, false)
      if (current) abortRequest(current.id)
    }
  }
)

let nextId = 0

async function drain(replies: AsyncIterator<string>) {
  try {
    while (!(await replies.next()).done) {
      // dropped
    }
  } catch {
    // The suggestion is already shown: a failure past its end changes nothing
  }
}

/**
 * Shows a suggestion at `request.pos` and streams it in. Resolves `shown`
 * (now waiting for Tab), `empty` (nothing to show; cleared) or `cancelled`
 * (cleared meanwhile: Esc, typing, a cursor move, a newer suggestion).
 * Rejects, after clearing, when the stream fails.
 */
export async function startSuggestion(
  view: EditorView,
  request: SuggestionRequest
): Promise<SuggestionOutcome> {
  const id = ++nextId
  const controller = new AbortController()
  controllers.set(id, controller)
  view.dispatch({
    effects: showSuggestion.of({ id, source: request.source, pos: request.pos }),
  })
  const alive = () => view.state.field(suggestionField, false)?.id === id

  let raw = ''
  let shown = false
  const firstText = () => {
    if (shown) return
    shown = true
    request.onFirstText?.()
  }

  if (!alive()) return { status: 'cancelled', raw }
  const replies = request.stream(controller.signal)[Symbol.asyncIterator]()
  let stopped = false
  try {
    while (true) {
      const next = await replies.next()
      if (next.done) break
      raw = next.value
      if (!alive()) {
        // Cleared meanwhile, which aborted the request: stop reading
        void replies.return?.(undefined)
        return { status: 'cancelled', raw }
      }
      const shaped = request.shape(raw, false)
      if (shaped.text) {
        firstText()
        view.dispatch({ effects: updateSuggestionText.of({ id, text: shaped.text }) })
      }
      if (shaped.stop) {
        stopped = true
        break
      }
    }
  } catch (error) {
    if (!alive()) return { status: 'cancelled', raw }
    view.dispatch({ effects: clearSuggestion.of(null) })
    throw error
  }

  // The request is done with: clearing the suggestion no longer aborts it
  controllers.delete(id)
  // Enough has arrived; the rest of the reply is read and dropped rather than
  // cut off, which a provider or gateway records as a cancelled request
  if (stopped) void drain(replies)
  if (!alive()) return { status: 'cancelled', raw }
  const text = request.shape(raw, true).text
  if (!text) {
    view.dispatch({ effects: clearSuggestion.of(null) })
    return { status: 'empty', raw }
  }
  firstText()
  view.dispatch({ effects: markReady.of({ id, text }) })
  return { status: 'shown', raw }
}

export function cancelSuggestion(view: EditorView) {
  if (view.state.field(suggestionField, false)) {
    view.dispatch({ effects: clearSuggestion.of(null) })
  }
}

/** Marks the clearing that makes way for a fresh suggestion (Shift+Space again). */
export const REGENERATE_EVENT = 'regenerate'

/** Clears the suggestion for a new one; not counted as the author ignoring it. */
export function regenerateSuggestion(view: EditorView) {
  if (view.state.field(suggestionField, false)) {
    view.dispatch({ effects: clearSuggestion.of(null), userEvent: REGENERATE_EVENT })
  }
}

/** Tab. While the text still streams, Tab is swallowed rather than indenting. */
export function acceptSuggestion(view: EditorView): boolean {
  const value = view.state.field(suggestionField, false)
  if (!value) return false
  if (value.status !== 'ready') return true
  view.dispatch({
    changes: { from: value.pos, insert: value.text },
    selection: { anchor: value.pos + value.text.length },
    effects: clearSuggestion.of(null),
    annotations: aiEdit.of(true),
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  return true
}

/** One word, one LaTeX command, or one other character, with the spaces before it. */
const NEXT_WORD = /^\s*(?:\\[A-Za-z@]+|[\p{L}\p{N}_]+|\S)/u

/** Ctrl/Cmd+→: inserts the next word of a ready suggestion; the rest stays. */
export function acceptWord(view: EditorView): boolean {
  const value = view.state.field(suggestionField, false)
  if (!value || value.status !== 'ready') return false
  const word = NEXT_WORD.exec(value.text)?.[0]
  if (!word) return false
  view.dispatch({
    changes: { from: value.pos, insert: word },
    selection: { anchor: value.pos + word.length },
    annotations: aiEdit.of(true),
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  return true
}

const suggestionKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptSuggestion },
    { key: 'Mod-ArrowRight', run: acceptWord },
    {
      key: 'Escape',
      run: view => {
        if (!view.state.field(suggestionField, false)) return false
        cancelSuggestion(view)
        return true
      },
    },
  ])
)

/** CodeMirror's `.cm-placeholder` colour, so ghost text reads as a placeholder. */
const suggestionTheme = EditorView.baseTheme({
  '.ai-inline-suggestion': {
    color: '#888',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  },
  '.ai-inline-suggestion-fade': {
    animation: `ai-inline-suggestion-fade ${FADE_MS}ms ease-out backwards`,
  },
  '.ai-inline-suggestion-hint': {
    marginLeft: '0.5em',
    animation: `ai-inline-suggestion-fade ${FADE_MS}ms ease-out backwards`,
  },
  '.ai-inline-suggestion-pulse': {
    display: 'inline-block',
    width: '0.45em',
    height: '0.45em',
    marginLeft: '0.2em',
    borderRadius: '50%',
    backgroundColor: 'currentColor',
    verticalAlign: 'middle',
    animation: 'ai-inline-suggestion-pulse 1s ease-in-out infinite',
  },
  '@keyframes ai-inline-suggestion-fade': {
    from: { opacity: 0, filter: 'blur(2px)' },
    to: { opacity: 1, filter: 'none' },
  },
  '@keyframes ai-inline-suggestion-pulse': {
    '0%, 100%': { opacity: 0.25, transform: 'scale(0.7)' },
    '50%': { opacity: 0.9, transform: 'scale(1)' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.ai-inline-suggestion-fade, .ai-inline-suggestion-hint, .ai-inline-suggestion-pulse': {
      animation: 'none',
    },
  },
})

export function inlineSuggestionEngine(): Extension {
  return [suggestionField, abortOnClear, revealPacer, suggestionKeymap, suggestionTheme]
}
