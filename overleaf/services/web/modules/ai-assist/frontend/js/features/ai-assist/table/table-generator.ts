import { EditorView } from '@codemirror/view'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { openTable, tableField } from './session'

/**
 * The `sourceEditorTableGenerators` entry. Upstream's Insert table menu
 * shows its "From text or image" item when an entry is available, and calls
 * `open` on click.
 */
const tableGenerator = {
  isAvailable: isWritingToolsAvailable,
  open(view: EditorView) {
    if (view.state.readOnly) return
    // undefined: the editor was built without the table extension
    if (view.state.field(tableField, false) === undefined) return
    openTable(view)
  },
}

export default tableGenerator
