import { expect } from 'chai'
import {
  backgroundHold,
  claimModel,
  noteWriting,
  onModelReleased,
  resetModelPriority,
  sharedEndpoint,
  WRITING_HOLD_MS,
} from '../../../../frontend/js/features/ai-assist/inline-context/model-priority'
import { ProviderSettings } from '../../../../frontend/js/features/ai-assist/providers/types'

const LOCAL: ProviderSettings = {
  type: 'openai',
  baseUrl: 'http://gpu-box:8080/v1/',
  apiKey: '',
  model: 'qwen',
}
const OLLAMA: ProviderSettings = { type: 'ollama', baseUrl: '', apiKey: '', model: 'llama' }
const CLOUD: ProviderSettings = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude',
}

describe('model priority', function () {
  beforeEach(function () {
    resetModelPriority()
  })

  it('treats a self-hosted server as shared, a provider API as not', function () {
    expect(sharedEndpoint(LOCAL)).to.equal('http://gpu-box:8080/v1')
    expect(sharedEndpoint(OLLAMA)).to.equal('http://localhost:11434')
    expect(sharedEndpoint(CLOUD)).to.equal(null)
  })

  it('holds the background check while a completion runs on the same server', function () {
    const release = claimModel({ ...LOCAL, model: 'other' })
    expect(backgroundHold(LOCAL)).to.equal(Infinity)
    expect(backgroundHold(OLLAMA)).to.equal(0)
    release()
    release()
    expect(backgroundHold(LOCAL)).to.equal(0)
  })

  it('holds until every overlapping completion has ended', function () {
    const a = claimModel(LOCAL)
    const b = claimModel(LOCAL)
    a()
    expect(backgroundHold(LOCAL)).to.equal(Infinity)
    b()
    expect(backgroundHold(LOCAL)).to.equal(0)
  })

  it('holds for a while after the author writes', function () {
    noteWriting(1000)
    expect(backgroundHold(LOCAL, 1000)).to.equal(WRITING_HOLD_MS)
    expect(backgroundHold(LOCAL, 1000 + WRITING_HOLD_MS)).to.equal(0)
  })

  it('never holds a provider API', function () {
    const release = claimModel(CLOUD)
    noteWriting()
    expect(backgroundHold(CLOUD)).to.equal(0)
    release()
  })

  it('tells listeners when a completion ends', function () {
    const seen: string[] = []
    const stop = onModelReleased(endpoint => seen.push(endpoint))
    claimModel(LOCAL)()
    claimModel(CLOUD)()
    stop()
    claimModel(LOCAL)()
    expect(seen).to.deep.equal(['http://gpu-box:8080/v1'])
  })
})
