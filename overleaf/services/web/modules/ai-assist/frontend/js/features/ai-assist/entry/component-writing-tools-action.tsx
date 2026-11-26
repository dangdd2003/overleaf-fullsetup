import { lazyComponent } from './gate'
import { isWritingToolsAvailable } from '../writing-tools/availability'

// Read by core synchronously to decide whether the menu row exists at all.
export const isAvailable = isWritingToolsAvailable

export default lazyComponent(() =>
  import(
    /* webpackChunkName: "ai-assist-component-writing-tools-action" */ '../components/writing-tools/writing-tools-action'
  ).then(m => ({ default: m.default }))
)
