import { expect } from 'chai'
import { SLASH_HARNESS } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/harness'
import { SLASH_COMMANDS } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'

// Every tool the model can call: the server's list (AiAssistTools.mjs,
// AiAssistWebTools.mjs, AiAssistModePolicy.mjs) and the registry's alias for
// get_compile_result. A harness that names anything else sends the model
// after a tool that is not there.
const REAL_TOOLS = new Set([
  'get_outline',
  'get_packages',
  'get_references',
  'list_files',
  'read_file',
  'search_text',
  'edit_file',
  'create_file',
  'compile_project',
  'get_compile_result',
  'get_compile_log',
  'view_compiled_pdf_page',
  'view_compiled_pdf_overview',
  'search_compiled_pdf',
  'get_project_settings',
  'configure_appearance_settings',
  'configure_compiler_settings',
  'configure_editor_settings',
  'list_available_settings',
  'web_search',
  'web_fetch',
  'present_plan',
])

const READ_SCOPE_COMMANDS = SLASH_COMMANDS.filter(
  command => command.scope === 'read'
).map(command => command.id)

const EDIT_SCOPE_COMMANDS = SLASH_COMMANDS.filter(
  command => command.scope === 'edit'
).map(command => command.id)

// Tool-shaped words: a backticked identifier with an underscore, or a bare
// word starting with a verb the tool names use.
const BACKTICKED_TOOL = /`([a-z]+(?:_[a-z]+)+)`/g
const BARE_TOOL =
  /\b(?:get|list|read|search|compile|edit|create|view|configure|present|web)_[a-z_]+\b/g

function toolNamesIn(text: string): string[] {
  const named = [...text.matchAll(BACKTICKED_TOOL)].map(match => match[1])
  const bare = [...text.matchAll(BARE_TOOL)].map(match => match[0])
  return [...named, ...bare]
}

describe('slash command harnesses', function () {
  it('has exactly one harness per command id', function () {
    const ids = SLASH_COMMANDS.map(command => command.id).sort()
    expect(Object.keys(SLASH_HARNESS).sort()).to.deep.equal(ids)
  })

  it('has a non-empty harness for every command', function () {
    for (const command of SLASH_COMMANDS) {
      const harness = SLASH_HARNESS[command.id]
      expect(harness, `harness for ${command.id}`).to.be.a('string')
      expect(harness.trim(), `harness for ${command.id}`).to.not.be.empty
    }
  })

  it('has no interpolation residue and no placeholder word', function () {
    for (const command of SLASH_COMMANDS) {
      const harness = SLASH_HARNESS[command.id]
      expect(harness, `${command.id} interpolates`).to.not.include('${')
      expect(harness, `${command.id} says undefined`).to.not.include('undefined')
    }
  })

  it('never closes the command block or its instructions early', function () {
    for (const command of SLASH_COMMANDS) {
      const harness = SLASH_HARNESS[command.id]
      expect(harness, `${command.id} closes </command`).to.not.include(
        '</command'
      )
      expect(harness, `${command.id} closes </instructions`).to.not.include(
        '</instructions'
      )
    }
  })

  it('names only tools that exist', function () {
    for (const command of SLASH_COMMANDS) {
      for (const name of toolNamesIn(SLASH_HARNESS[command.id])) {
        expect(REAL_TOOLS, `${command.id} names ${name}`).to.include(name)
      }
    }
  })

  it('keeps read-scope commands away from edits and compiles', function () {
    expect(READ_SCOPE_COMMANDS).to.have.members([
      'explain',
      'review',
      'check',
      'summarize',
    ])
    for (const id of READ_SCOPE_COMMANDS) {
      expect(SLASH_HARNESS[id], `${id} edits`).to.not.match(
        /\b(edit_file|create_file|compile_project)\b/
      )
      expect(SLASH_HARNESS[id], `${id} says read only`).to.match(
        /Read only/
      )
    }
  })

  it('says when an edit command compiles, so the model never guesses', function () {
    for (const id of EDIT_SCOPE_COMMANDS) {
      expect(SLASH_HARNESS[id], `${id} compile policy`).to.match(/compile/i)
    }
  })

  it('has the fix start from the gathered errors, not from a re-read', function () {
    expect(SLASH_HARNESS.fix).to.include('the first entry in <compile-errors>')
    expect(SLASH_HARNESS.fix).to.include('Warnings are out of scope')
  })

  it('names only gathered blocks the command actually gathers', function () {
    const TAGS: Record<string, string> = {
      'compile-errors': 'compileErrors',
      'layout-warnings': 'layoutWarnings',
      preamble: 'preamble',
      section: 'currentSection',
      source: 'cursorWindow',
      outline: 'outline',
      'bib-keys': 'bibKeys',
      labels: 'labels',
      packages: 'packages',
      macros: 'macros',
    }
    for (const command of SLASH_COMMANDS) {
      const harness = SLASH_HARNESS[command.id]
      for (const [tag, gatherer] of Object.entries(TAGS)) {
        if (!harness.includes(`<${tag}>`)) continue
        // A missing heading falls back to the window, so <section> may say <source>
        expect(command.gather, `${command.id} reads <${tag}>`).to.include(gatherer)
      }
    }
  })

  it('names <params> only in commands that have params', function () {
    for (const command of SLASH_COMMANDS) {
      if (SLASH_HARNESS[command.id].includes('<params>')) {
        expect(command.params, command.id).to.not.be.empty
      }
    }
  })

  it('tells prose-only edits not to compile', function () {
    for (const id of ['rewrite', 'proofread'] as const) {
      expect(SLASH_HARNESS[id], `${id} compiles`).to.match(
        /Do not compile: prose only/
      )
    }
  })

  it('never lets cite or bib write an entry from memory', function () {
    expect(SLASH_HARNESS.cite).to.include('Never write an entry from memory')
    expect(SLASH_HARNESS.bib).to.include('never from memory')
  })
})
