import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(
    /* webpackChunkName: "ai-assist-component-right-panel" */ '../components/agent/ai-assist-right-panel'
  ).then(m => ({ default: m.default }))
)
