import { Extension } from '@codemirror/state'
import { lazyExtension } from './gate-extension'

export const extension = (): Extension =>
  lazyExtension(() =>
    import(/* webpackChunkName: "ai-assist-extension-writing-tools" */ '../writing-tools/extension').then(m =>
      m.extension()
    )
  )
