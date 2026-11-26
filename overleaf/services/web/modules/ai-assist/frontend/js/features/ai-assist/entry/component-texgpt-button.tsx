import { lazyComponent } from './gate'

export default lazyComponent(() =>
  import(/* webpackChunkName: "ai-assist-component-texgpt-button" */ '../components/texgpt/texgpt-button').then(m => ({
    default: m.default,
  }))
)
