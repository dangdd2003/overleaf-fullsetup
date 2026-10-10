import { EditorView } from '@codemirror/view'
import importOverleafModules from '../../../../../macros/import-overleaf-module.macro'

type Generator = {
  isAvailable: () => boolean
  open: (view: EditorView) => void
}

type GeneratorEntry = { import: { default: Generator }; path: string }

// "From text or image" generators provided by a module when Writefull is not there
const generators = {
  math: importOverleafModules('sourceEditorMathGenerators') as GeneratorEntry[],
  table: importOverleafModules(
    'sourceEditorTableGenerators'
  ) as GeneratorEntry[],
}

/** The module's generator of the given kind, when one is available to this user. */
export const findGenerator = (kind: keyof typeof generators) =>
  generators[kind].find(({ import: { default: entry } }) =>
    entry?.isAvailable?.()
  )?.import.default
