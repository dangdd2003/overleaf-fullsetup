import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-suggest-fix" */ '../components/last-fix-banner').then(m => ({
    default: m.default,
  }))
)
