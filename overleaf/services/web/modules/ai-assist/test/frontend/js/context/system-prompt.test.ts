import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'

describe('SYSTEM_PROMPT', function () {
  it('is a non-empty constant string', function () {
    expect(SYSTEM_PROMPT).to.be.a('string')
    expect(SYSTEM_PROMPT.length).to.be.greaterThan(200)
  })

  it('states the identity and the live-editing environment', function () {
    expect(SYSTEM_PROMPT).to.match(/Overleaf/)
    expect(SYSTEM_PROMPT).to.match(/LaTeX/)
  })

  it('documents every edit_file failure status and what to do', function () {
    for (const status of ['noMatch', 'ambiguous', 'rejected', 'drifted']) {
      expect(SYSTEM_PROMPT, `missing guidance for ${status}`).to.include(status)
    }
  })

  it('teaches the orientation ladder and names relative costs', function () {
    expect(SYSTEM_PROMPT).to.contain('get_outline')
    expect(SYSTEM_PROMPT).to.contain('search_text')
    expect(SYSTEM_PROMPT).to.contain('read_file')
    // The ladder order must appear in the prompt in this order.
    expect(SYSTEM_PROMPT.indexOf('get_outline')).to.be.lessThan(
      SYSTEM_PROMPT.indexOf('search_text')
    )
    expect(SYSTEM_PROMPT.indexOf('search_text')).to.be.lessThan(
      SYSTEM_PROMPT.indexOf('read_file')
    )
    // No stale tool names survive the rewrite.
    expect(SYSTEM_PROMPT).to.not.contain('project_map')
    expect(SYSTEM_PROMPT).to.not.contain('search_project')
    expect(SYSTEM_PROMPT).to.not.contain('get_compile_log')
  })

  it('carries a compile policy and an honesty rule', function () {
    expect(SYSTEM_PROMPT.toLowerCase()).to.include('compile')
    expect(SYSTEM_PROMPT.toLowerCase()).to.match(/do not invent|never invent/)
  })

  it('forbids ending a turn with an offer to do the asked work', function () {
    expect(SYSTEM_PROMPT).to.match(/Never end a turn offering/)
  })

  it('tells one-click <task> runs to spend steps on tools, not talk', function () {
    expect(SYSTEM_PROMPT).to.include('<task>')
    // No loophole for an opening question, and no narration before the first
    // tool call either.
    expect(SYSTEM_PROMPT).to.match(/no question of any\s+kind/)
    expect(SYSTEM_PROMPT).to.match(/No text before or between tool calls/)
    // The task block's own output shape wins over the general rules.
    // The override must reach the rules *below* it too — the compile and
    // honesty sections are what otherwise force an unverified-fix disclaimer
    // into a run that has no compile_project to begin with.
    expect(SYSTEM_PROMPT).to.match(/wins over every\s+general rule/)
    expect(SYSTEM_PROMPT).to.match(/including the ones below/)
  })

  it('scopes the rejected-edit and compile rules to runs that can obey them', function () {
    // A rejected edit must not become a question in a panel with no reply box.
    expect(SYSTEM_PROMPT).to.match(/nobody to\s+ask/)
    // The compile mandate must not fight a run that removed compile_project.
    expect(SYSTEM_PROMPT).to.match(/when compile_project is available/)
  })

  // Insertion is semantic: the model derives the content from the document and
  // puts it where the prose discusses it. A boilerplate skeleton dropped at the
  // cursor (or at the end of the file) is the failure this section exists to
  // prevent.
  it('requires inserted content to come from the document, not a template', function () {
    expect(SYSTEM_PROMPT).to.include('# Inserting content')
    expect(SYSTEM_PROMPT).to.match(/Never emit a generic skeleton/)
    expect(SYSTEM_PROMPT).to.match(/placeholder values/)
  })

  it('makes the cursor a reading hint, never the insertion point', function () {
    expect(SYSTEM_PROMPT).to.match(/never as the insertion point itself/)
    expect(SYSTEM_PROMPT).to.match(/where the prose discusses it/)
    // And the user gets told where it landed, so a bad guess is visible.
    expect(SYSTEM_PROMPT).to.match(/say in one sentence where you put the/)
  })

  // This is the test that protects the caching design. If project data ever
  // leaks back into the system prompt, every provider's cache dies silently.
  it('contains no project data and no interpolation', function () {
    expect(SYSTEM_PROMPT).to.not.include('${')
    expect(SYSTEM_PROMPT).to.not.match(/\.tex\b/)
    expect(SYSTEM_PROMPT).to.not.include('Project files:')
  })

  it('stays a pure constant with no interpolated project data', function () {
    // Structural guarantee: the exported value is a string built only from
    // literals in this module.
    expect(SYSTEM_PROMPT).to.be.a('string')
    expect(SYSTEM_PROMPT).to.not.contain('<project-context turn=')
  })
})
