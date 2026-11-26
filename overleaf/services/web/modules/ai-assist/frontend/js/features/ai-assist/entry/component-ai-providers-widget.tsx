import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-ai-providers-widget" */ '../components/ai-providers-widget').then(m => ({
    default: m.default,
  }))
)
