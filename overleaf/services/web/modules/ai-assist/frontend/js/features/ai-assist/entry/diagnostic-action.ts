import type { DiagnosticAction } from '@/features/source-editor/extensions/annotations'
import { preloaded } from './gate'

const impl = preloaded(() =>
  import(
    /* webpackChunkName: "ai-assist-diagnostic-action" */ '../diagnostic-action'
  ).then(m => m.default)
)

const diagnosticAction: DiagnosticAction = diagnostic =>
  impl()?.(diagnostic) ?? null

export default diagnosticAction
