import { expect } from 'chai'
import { FIX_SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/fix-system-prompt'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import { buildRequest } from '../../../../frontend/js/features/ai-assist/agent/context/build-request'

describe('FIX_SYSTEM_PROMPT', function () {
  it('is substantially smaller than the rail prompt', function () {
    // The whole point: a one-click fix should not pay for the rail's manual on
    // orienting, inserting content and compiling. If this ever creeps back up
    // to the rail's size, the optimisation has been undone.
    expect(FIX_SYSTEM_PROMPT.length).to.be.lessThan(SYSTEM_PROMPT.length * 0.75)
  })

  it('drops the rail machinery a local fix cannot use', function () {
    // No orientation ladder: the code is handed over, not discovered.
    expect(FIX_SYSTEM_PROMPT).to.not.contain('project_map')
    expect(FIX_SYSTEM_PROMPT).to.not.contain('search_project')
    // No insert-content policy and no compile policy.
    expect(FIX_SYSTEM_PROMPT).to.not.contain('# Inserting content')
    expect(FIX_SYSTEM_PROMPT).to.not.contain('compile_project')
  })

  it('says the code is already in the message', function () {
    expect(FIX_SYSTEM_PROMPT).to.match(/lines around it/)
    expect(FIX_SYSTEM_PROMPT).to.match(/before you reach\s+for a tool/)
  })

  it('keeps the rules that stop a dead-end answer', function () {
    expect(FIX_SYSTEM_PROMPT).to.match(/no reply box/i)
    expect(FIX_SYSTEM_PROMPT).to.match(/Never ask a question/)
    expect(FIX_SYSTEM_PROMPT).to.match(/no text\s+between them/)
  })

  it('keeps the edit contract, including every failure status', function () {
    expect(FIX_SYSTEM_PROMPT).to.contain('oldText')
    for (const status of ['noMatch', 'ambiguous', 'rejected', 'drifted']) {
      expect(FIX_SYSTEM_PROMPT, `missing guidance for ${status}`).to.include(
        status
      )
    }
  })

  it('ranks fixes by how invasive they are', function () {
    expect(FIX_SYSTEM_PROMPT).to.match(/least invasive/)
    expect(FIX_SYSTEM_PROMPT).to.match(/fewest lines/)
  })

  it('answers with an edit, never with only an explanation', function () {
    expect(FIX_SYSTEM_PROMPT).to.match(/Your answer is an edit/)
    expect(FIX_SYSTEM_PROMPT).to.match(/Never answer with only an\s+explanation/)
    expect(FIX_SYSTEM_PROMPT).to.not.match(/Not\s+every entry is a defect/i)
  })

  // Same caching contract as the rail's prompt: a constant, or every request
  // re-reads the whole prefix.
  it('carries no project data and no interpolation', function () {
    expect(FIX_SYSTEM_PROMPT).to.not.include('${')
    expect(FIX_SYSTEM_PROMPT).to.not.include('<project-context turn=')
  })

  it('is what buildRequest sends when a run overrides the prompt', function () {
    const transcript = [
      { id: 'u0', role: 'user' as const, text: 'fix it', attachments: [] },
    ]
    const limits = { contextWindow: 128000, maxOutputTokens: 8192 }

    const railRun = buildRequest({ transcript, limits })
    expect(railRun.system).to.equal(SYSTEM_PROMPT)

    const fixRun = buildRequest({
      transcript,
      limits,
      systemPrompt: FIX_SYSTEM_PROMPT,
    })
    expect(fixRun.system).to.equal(FIX_SYSTEM_PROMPT)
    // Still cached as a stable prefix, exactly like the rail's.
    expect(fixRun.cacheHints.cacheSystem).to.equal(true)
  })
})
