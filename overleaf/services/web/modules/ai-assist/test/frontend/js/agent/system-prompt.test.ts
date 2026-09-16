import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

describe('the system prompt describes the real tool surface', function () {
  it('names no tool that does not exist', function () {
    const named = SYSTEM_PROMPT.match(/`([a-z_]+)`/g) ?? []
    const toolish = named
      .map(m => m.replace(/`/g, ''))
      .filter(name => name.includes('_') && !name.startsWith('\\'))
    for (const name of toolish) {
      if (/^(get|list|read|search|compile|edit|create)_/.test(name)) {
        expect(TOOLS, `prompt names ${name}`).to.have.property(name)
      }
    }
  })

  it('no longer mentions the retired god-tool', function () {
    expect(SYSTEM_PROMPT).to.not.contain('project_map')
  })

  it('mentions every tool the model can call', function () {
    for (const name of Object.keys(TOOLS)) {
      expect(SYSTEM_PROMPT, `prompt omits ${name}`).to.contain(name)
    }
  })
})
