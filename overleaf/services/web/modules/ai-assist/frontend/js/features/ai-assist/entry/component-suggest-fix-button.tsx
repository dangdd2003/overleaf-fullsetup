import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-suggest-fix" */ '../components/suggest-fix-button').then(m => ({
    default: m.default,
  }))
)
