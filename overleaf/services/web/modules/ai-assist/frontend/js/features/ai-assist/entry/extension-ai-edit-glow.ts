import { Extension } from '@codemirror/state'
import { lazyExtension } from './gate-extension'

export const extension = (): Extension =>
  lazyExtension(() =>
    import(/* webpackChunkName: "ai-assist-extension-ai-edit-glow" */ '../ai-edit-glow/extension').then(m =>
      m.extension()
    )
  )
