import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  SLASH_COMMAND_SCOPES,
  activeCommandFrom,
  combineDecisions,
  normalizeCommandId,
  normalizeCommandInvocation,
  scopeDecision,
  scopeRefusal,
} from '../../../app/src/AiAssistSlashCommands.mjs'
import { decide } from '../../../app/src/AiAssistModePolicy.mjs'

// The ids of SLASH_COMMANDS in
// frontend/js/features/ai-assist/agent/slash-commands/catalog.ts. Keep in step.
const CATALOG_IDS = [
  'fix',
  'layout',
  'preamble',
  'rewrite',
  'proofread',
  'translate',
  'cite',
  'bib',
  'table',
  'figure',
  'equation',
  'explain',
  'summarize',
  'review',
  'check',
]

const READ_TOOLS = [
  'read_file',
  'search_text',
  'get_outline',
  'get_compile_result',
  'view_compiled_pdf_page',
  'get_project_settings',
  'list_available_settings',
  'web_search',
  'web_fetch',
]

const SETTINGS = [
  'configure_appearance_settings',
  'configure_compiler_settings',
  'configure_editor_settings',
]

describe('AiAssistSlashCommands', function () {
  describe('SLASH_COMMAND_SCOPES', function () {
    it('has exactly the catalog ids', function () {
      expect(Object.keys(SLASH_COMMAND_SCOPES).sort()).to.deep.equal(
        [...CATALOG_IDS].sort()
      )
    })

    it('makes the four review commands read-only and the rest edit', function () {
      const read = Object.keys(SLASH_COMMAND_SCOPES).filter(
        id => SLASH_COMMAND_SCOPES[id] === 'read'
      )
      expect(read.sort()).to.deep.equal(
        ['check', 'explain', 'review', 'summarize'].sort()
      )
      for (const id of CATALOG_IDS) {
        expect(SLASH_COMMAND_SCOPES[id], id).to.be.oneOf(['read', 'edit'])
      }
    })
  })

  describe('normalizeCommandId and normalizeCommandInvocation', function () {
    it('accepts known ids only', function () {
      expect(normalizeCommandId('fix')).to.equal('fix')
      expect(normalizeCommandId('improve')).to.be.null
      expect(normalizeCommandId('constructor')).to.be.null
      expect(normalizeCommandId(undefined)).to.be.null
      expect(normalizeCommandId(7)).to.be.null
    })

    it('keeps a known command with string args, defaulting args to empty', function () {
      expect(normalizeCommandInvocation({ id: 'rewrite', args: 'formal' })).to.deep.equal({
        id: 'rewrite',
        args: 'formal',
      })
      expect(normalizeCommandInvocation({ id: 'review' })).to.deep.equal({
        id: 'review',
        args: '',
      })
    })

    it('drops a command with an unknown id or non-string args', function () {
      expect(normalizeCommandInvocation({ id: 'nope', args: '' })).to.be.null
      expect(normalizeCommandInvocation({ id: 'fix', args: 3 })).to.be.null
      expect(normalizeCommandInvocation(null)).to.be.null
    })
  })

  describe('activeCommandFrom', function () {
    it('is the command id of a turn sent with one', function () {
      expect(
        activeCommandFrom({ role: 'user', command: { id: 'review', args: '' } })
      ).to.equal('review')
    })

    it('is null for a plain turn, or an id no command has', function () {
      expect(activeCommandFrom({ role: 'user', text: 'hi' })).to.be.null
      expect(activeCommandFrom({ command: { id: 'bogus' } })).to.be.null
      expect(activeCommandFrom(undefined)).to.be.null
    })
  })

  describe('scopeDecision', function () {
    it('lets a read command read and denies edits, compiling and settings', function () {
      for (const tool of READ_TOOLS) {
        expect(scopeDecision('read', tool), tool).to.equal('allow')
      }
      for (const tool of ['edit_file', 'create_file', 'compile_project', ...SETTINGS]) {
        expect(scopeDecision('read', tool), tool).to.equal('deny')
      }
    })

    it('lets an edit command edit and compile but not change settings', function () {
      for (const tool of READ_TOOLS) {
        expect(scopeDecision('edit', tool), tool).to.equal('allow')
      }
      for (const tool of ['edit_file', 'create_file', 'compile_project']) {
        expect(scopeDecision('edit', tool), tool).to.equal('allow')
      }
      for (const tool of SETTINGS) {
        expect(scopeDecision('edit', tool), tool).to.equal('deny')
      }
    })

    it('denies a tool the scope does not know about', function () {
      expect(scopeDecision('read', 'some_new_tool')).to.equal('deny')
      expect(scopeDecision('edit', 'some_new_tool')).to.equal('deny')
    })

    it('handles connectors: read commands only use read-only ones, edit defers to the mode', function () {
      expect(
        scopeDecision('read', 'mcp__docs__search', { readOnly: true })
      ).to.equal('allow')
      expect(scopeDecision('read', 'mcp__docs__write', {})).to.equal('deny')
      expect(scopeDecision('edit', 'mcp__docs__write', {})).to.equal('allow')
    })

    it('lets every command use the connector search and paging tools', function () {
      for (const scope of ['read', 'edit']) {
        expect(scopeDecision(scope, 'search_connector_tools')).to.equal('allow')
        expect(scopeDecision(scope, 'read_connector_result')).to.equal('allow')
      }
    })

    it('never restricts present_plan, which the mode decides', function () {
      expect(scopeDecision('read', 'present_plan')).to.equal('allow')
      expect(scopeDecision('edit', 'present_plan')).to.equal('allow')
    })

    it('does not restrict a plain message, a full scope or an unknown scope', function () {
      expect(scopeDecision(null, 'configure_editor_settings')).to.equal('allow')
      expect(scopeDecision('full', 'configure_editor_settings')).to.equal('allow')
      expect(scopeDecision(undefined, 'edit_file')).to.equal('allow')
    })
  })

  describe('combineDecisions', function () {
    it('takes the stricter of the decisions', function () {
      expect(combineDecisions('allow', 'allow')).to.equal('allow')
      expect(combineDecisions('allow', 'ask')).to.equal('ask')
      expect(combineDecisions('ask', 'deny')).to.equal('deny')
      expect(combineDecisions('deny', 'allow')).to.equal('deny')
    })

    it('never turns an ask into an allow', function () {
      // The scope allows an edit; manual mode still asks for it
      const scope = scopeDecision('edit', 'edit_file')
      expect(scope).to.equal('allow')
      expect(combineDecisions(decide('manual', 'edit_file'), scope)).to.equal('ask')
      expect(combineDecisions(decide('acceptEdits', 'edit_file'), scope)).to.equal('allow')
      expect(combineDecisions(decide('plan', 'edit_file'), scope)).to.equal('deny')
    })
  })

  describe('scopeRefusal', function () {
    it('says which command, which tool and what to do instead', function () {
      expect(scopeRefusal('review', 'edit_file')).to.equal(
        "`edit_file` is outside /review's scope: this command only reads. Report the change instead of making it."
      )
    })

    it('names what an edit command may do', function () {
      expect(scopeRefusal('rewrite', 'configure_editor_settings')).to.equal(
        "`configure_editor_settings` is outside /rewrite's scope: this command only edits files and compiles. Report the change instead of making it."
      )
    })
  })
})
