import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-inline-popup" */ '../components/inline-suggestion/inline-popup').then(m => ({
    default: m.default,
  }))
)
