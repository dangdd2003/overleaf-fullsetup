import { EditorView } from '@codemirror/view'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { equationField, openEquation } from './session'

/**
 * The `sourceEditorMathGenerators` entry. Upstream's Insert math menu shows
 * its "From text or image" item when an entry is available, and calls
 * `open` on click.
 */
const mathGenerator = {
  isAvailable: isWritingToolsAvailable,
  open(view: EditorView) {
    if (view.state.readOnly) return
    // undefined: the editor was built without the equation extension
    if (view.state.field(equationField, false) === undefined) return
    openEquation(view)
  },
}

export default mathGenerator
