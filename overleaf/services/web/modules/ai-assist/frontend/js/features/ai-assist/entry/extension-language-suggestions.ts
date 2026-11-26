import { Extension } from '@codemirror/state'
import { lazyExtension } from './gate-extension'

export const extension = (): Extension =>
  lazyExtension(() =>
    import(/* webpackChunkName: "ai-assist-extension-language-suggestions" */ '../language-suggestions/extension').then(m =>
      m.extension()
    )
  )
