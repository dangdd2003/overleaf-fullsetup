import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-suggestion-card-host" */ '../components/language-suggestions/suggestion-card-host').then(m => ({
    default: m.default,
  }))
)
