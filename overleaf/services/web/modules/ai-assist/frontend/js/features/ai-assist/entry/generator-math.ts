import type { EditorView } from '@codemirror/view'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { preloaded } from './gate'

const load = () =>
  import(
    /* webpackChunkName: "ai-assist-generator-math" */ '../equation/math-generator'
  ).then(m => m.default)
const impl = preloaded(load)

// Core calls isAvailable synchronously, so it reads the same flag directly
// and the menu row exists without waiting for the chunk.
export default {
  isAvailable: isWritingToolsAvailable,
  open(view: EditorView) {
    if (!isWritingToolsAvailable()) return
    const loaded = impl()
    if (loaded) return loaded.open(view)
    void load()
      .then(m => {
        if (isWritingToolsAvailable()) m.open(view)
      })
      .catch(() => {})
  },
}
