import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import {
  SYSTEM_PROMPT,
  MODE_PROMPTS,
  WEB_TOOLS_PROMPT,
  systemPromptFor,
} from '../../../app/src/AiAssistSystemPrompt.mjs'

describe('AiAssistSystemPrompt', () => {
  it('preserves SYSTEM_PROMPT as a string', () => {
    expect(SYSTEM_PROMPT).to.be.a('string')
    expect(SYSTEM_PROMPT.length).to.be.greaterThan(200)
  })

  it('provides distinct, non-empty MODE_PROMPTS for each mode', () => {
    expect(MODE_PROMPTS.manual).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.acceptEdits).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.plan).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.manual).to.not.equal(MODE_PROMPTS.plan)
  })

  it('systemPromptFor appends the respective mode prompt', () => {
    const manualPrompt = systemPromptFor('manual')
    expect(manualPrompt).to.equal(`${SYSTEM_PROMPT}\n\n${MODE_PROMPTS.manual}`)

    const acceptPrompt = systemPromptFor('acceptEdits')
    expect(acceptPrompt).to.equal(`${SYSTEM_PROMPT}\n\n${MODE_PROMPTS.acceptEdits}`)

    const planPrompt = systemPromptFor('plan')
    expect(planPrompt).to.equal(`${SYSTEM_PROMPT}\n\n${MODE_PROMPTS.plan}`)
    expect(planPrompt).to.include('present_plan')

    // Defaults to manual on unknown
    expect(systemPromptFor('invalid')).to.equal(manualPrompt)
  })

  it('adds the web research section before the mode only when web tools are on', () => {
    expect(systemPromptFor('manual', { webTools: false })).to.equal(systemPromptFor('manual'))
    const withWeb = systemPromptFor('plan', { webTools: true })
    expect(withWeb).to.equal(`${SYSTEM_PROMPT}\n\n${WEB_TOOLS_PROMPT}\n\n${MODE_PROMPTS.plan}`)
  })
})
