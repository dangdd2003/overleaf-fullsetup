import { Extension } from '@codemirror/state'
import { lazyExtension } from './gate-extension'

export const extension = (): Extension =>
  lazyExtension(() =>
    import(/* webpackChunkName: "ai-assist-extension-inline-suggestion" */ '../inline-suggestion/extension').then(m =>
      m.extension()
    )
  )
