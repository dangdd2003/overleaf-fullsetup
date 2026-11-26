import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-table-host" */ '../components/table/table-host').then(m => ({
    default: m.default,
  }))
)
