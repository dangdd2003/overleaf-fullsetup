import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-apply-fix-listener" */ '../components/apply-fix-listener').then(m => ({
    default: m.default,
  }))
)
