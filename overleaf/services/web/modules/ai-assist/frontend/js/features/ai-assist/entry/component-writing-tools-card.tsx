import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-writing-tools-card" */ '../components/writing-tools/writing-tools-card').then(m => ({
    default: m.default,
  }))
)
