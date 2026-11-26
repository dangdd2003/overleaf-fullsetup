import { Compartment, Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { aiAssistEnabled } from './gate'

/**
 * A CodeMirror extension that is empty when disabled. When enabled, the real
 * extension is swapped in through a compartment as soon as its chunk loads,
 * which starts when the editor view is created.
 */
export function lazyExtension(load: () => Promise<Extension>): Extension {
  if (!aiAssistEnabled()) return []
  const slot = new Compartment()
  return [
    slot.of([]),
    ViewPlugin.define((view: EditorView) => {
      let destroyed = false
      void load()
        .then(extension => {
          if (!destroyed) {
            view.dispatch({ effects: slot.reconfigure(extension) })
          }
        })
        .catch(() => {})
      return {
        destroy() {
          destroyed = true
        },
      }
    }),
  ]
}
