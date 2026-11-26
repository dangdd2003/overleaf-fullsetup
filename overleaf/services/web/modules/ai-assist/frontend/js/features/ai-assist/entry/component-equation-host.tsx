import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-equation-host" */ '../components/equation/equation-host').then(m => ({
    default: m.default,
  }))
)
