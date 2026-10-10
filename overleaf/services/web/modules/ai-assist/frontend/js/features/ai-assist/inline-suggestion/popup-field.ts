import { Extension, Prec, StateEffect, StateField } from '@codemirror/state'
import {
  EditorView,
  keymap,
  showTooltip,
  Tooltip,
  TooltipView,
} from '@codemirror/view'
import type { TexGptNotice } from '../components/texgpt/texgpt-notices'

/** `prompt`: the TeXGPT bar on an empty line. `notice`: a message at the cursor (sentence completion). */
export type InlinePopupMode = 'prompt' | 'notice'

export type InlinePopup = {
  /** New for every opening; the popup keys its React state on it. */
  id: number
  pos: number
  mode: InlinePopupMode
  notice: TexGptNotice | null
  /** What the bar starts with (kept when it reopens after a failed request). */
  prompt: string
  tooltip: Tooltip
}

export type OpenInlinePopup = {
  pos: number
  mode: InlinePopupMode
  notice?: TexGptNotice | null
  prompt?: string
}

export const openInlinePopup = StateEffect.define<OpenInlinePopup>()
export const closeInlinePopup = StateEffect.define<null>()

let nextPopupId = 0

/**
 * One function for every popup tooltip, so CodeMirror reuses its DOM (and the
 * React tree portalled into it) when the popup moves with an edit.
 */
const createPopupContainer = (): TooltipView => {
  const dom = document.createElement('div')
  dom.className = 'ai-inline-popup-container'
  return { dom, overlap: true, offset: { x: 0, y: 6 } }
}

function popupTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    strictSide: true,
    arrow: false,
    create: createPopupContainer,
  }
}

export const inlinePopupField = StateField.define<InlinePopup | null>({
  create: () => null,
  update(popup, tr) {
    for (const effect of tr.effects) {
      if (effect.is(closeInlinePopup)) return null
      if (effect.is(openInlinePopup)) {
        const { pos, mode, notice = null, prompt = '' } = effect.value
        popup = { id: ++nextPopupId, pos, mode, notice, prompt, tooltip: popupTooltip(pos) }
      }
    }
    if (!popup) return null
    if (tr.docChanged) {
      if (popup.mode === 'notice') return null
      const pos = tr.changes.mapPos(popup.pos)
      // Someone typed on the line: it is no longer an empty line to write on
      if (tr.state.doc.lineAt(pos).length !== 0) return null
      if (pos !== popup.pos) popup = { ...popup, pos, tooltip: popupTooltip(pos) }
    }
    if (tr.selection && tr.state.selection.main.head !== popup.pos) return null
    return popup
  },
  provide: field => showTooltip.from(field, popup => popup?.tooltip ?? null),
})

const popupTheme = EditorView.baseTheme({
  '.ai-inline-popup-container.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
  },
})

export function inlinePopupExtension(): Extension {
  return [
    inlinePopupField,
    popupTheme,
    Prec.high(
      keymap.of([
        {
          // The bar handles its own Esc; this one is for the notice popup,
          // which leaves the focus in the editor
          key: 'Escape',
          run: view => {
            if (!view.state.field(inlinePopupField, false)) return false
            view.dispatch({ effects: closeInlinePopup.of(null) })
            return true
          },
        },
      ])
    ),
  ]
}
