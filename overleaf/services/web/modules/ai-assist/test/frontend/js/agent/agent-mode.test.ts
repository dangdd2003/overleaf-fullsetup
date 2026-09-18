import { expect } from 'chai'
import {
  AGENT_MODES,
  nextMode,
  AgentMode,
} from '../../../../frontend/js/features/ai-assist/agent/agent-mode'

describe('agent-mode', () => {
  it('defines the three supported modes', () => {
    expect(AGENT_MODES).to.deep.equal(['manual', 'acceptEdits', 'plan'])
  })

  it('cycles modes with nextMode', () => {
    expect(nextMode('manual')).to.equal('acceptEdits')
    expect(nextMode('acceptEdits')).to.equal('plan')
    expect(nextMode('plan')).to.equal('manual')
    expect(nextMode('unknown' as AgentMode)).to.equal('manual')
  })
})
