import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-toolbar-control" */ '../components/language-suggestions/toolbar-control').then(m => ({
    default: m.default,
  }))
)
