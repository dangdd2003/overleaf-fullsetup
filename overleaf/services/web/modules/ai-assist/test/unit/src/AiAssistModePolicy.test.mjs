import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  MODES,
  DEFAULT_MODE,
  normalizeMode,
  decide,
  toolSpecsFor,
  PRESENT_PLAN_SPEC,
  FILE_EDIT_TOOLS,
  READ_ONLY_TOOLS,
  SETTINGS_TOOLS,
  PROJECT_SETTINGS_TOOLS,
  ACCOUNT_SETTINGS_TOOLS,
  PLAN_TOOL,
  CONNECTOR_SEARCH_TOOL,
  READ_CONNECTOR_RESULT_TOOL,
  isConnectorCallName,
  modeLabel,
} from '../../../app/src/AiAssistModePolicy.mjs'

describe('AiAssistModePolicy', () => {
  describe('normalizeMode', () => {
    it('returns valid modes unchanged', () => {
      expect(normalizeMode('manual')).to.equal('manual')
      expect(normalizeMode('acceptEdits')).to.equal('acceptEdits')
      expect(normalizeMode('plan')).to.equal('plan')
    })

    it('defaults invalid or missing values to manual', () => {
      expect(normalizeMode(undefined)).to.equal(DEFAULT_MODE)
      expect(normalizeMode(null)).to.equal(DEFAULT_MODE)
      expect(normalizeMode('')).to.equal(DEFAULT_MODE)
      expect(normalizeMode('unknown')).to.equal(DEFAULT_MODE)
    })
  })

  describe('decide', () => {
    it('lets every mode, plan included, look at the compiled PDF and point the viewer at it', () => {
      for (const tool of [
        'view_compiled_pdf_page',
        'view_compiled_pdf_overview',
        'search_compiled_pdf',
        'highlight_in_pdf',
      ]) {
        expect(READ_ONLY_TOOLS.has(tool)).to.equal(true)
        for (const mode of MODES) {
          expect(decide(mode, tool)).to.equal('allow')
        }
      }
    })

    it('handles manual mode', () => {
      expect(decide('manual', 'read_file')).to.equal('allow')
      expect(decide('manual', 'compile_project')).to.equal('allow')
      expect(decide('manual', 'edit_file')).to.equal('ask')
      expect(decide('manual', 'create_file')).to.equal('ask')
      expect(decide('manual', 'configure_appearance_settings')).to.equal('ask')
      expect(decide('manual', 'present_plan')).to.equal('deny')
    })

    it('handles acceptEdits mode', () => {
      expect(decide('acceptEdits', 'read_file')).to.equal('allow')
      expect(decide('acceptEdits', 'compile_project')).to.equal('allow')
      expect(decide('acceptEdits', 'edit_file')).to.equal('allow')
      expect(decide('acceptEdits', 'create_file')).to.equal('allow')
      expect(decide('acceptEdits', 'configure_editor_settings')).to.equal('ask')
      expect(decide('acceptEdits', 'present_plan')).to.equal('deny')
    })

    it('applies project settings without asking in acceptEdits mode', () => {
      // The compiler engine and root document are project state, exactly like a
      // file is, so the mode that accepts file edits accepts them too.
      expect(decide('acceptEdits', 'configure_compiler_settings')).to.equal(
        'allow'
      )
      expect(decide('manual', 'configure_compiler_settings')).to.equal('ask')
    })

    it('still confirms account settings in acceptEdits mode', () => {
      // These are written to the user account and follow them out of the
      // project, so no project-scoped mode may apply them silently.
      for (const tool of ACCOUNT_SETTINGS_TOOLS) {
        expect(decide('acceptEdits', tool), tool).to.equal('ask')
        expect(decide('manual', tool), tool).to.equal('ask')
        expect(decide('plan', tool), tool).to.equal('deny')
      }
    })

    it('splits the settings tools into project and account scope', () => {
      expect([...SETTINGS_TOOLS].sort()).to.deep.equal(
        [...PROJECT_SETTINGS_TOOLS, ...ACCOUNT_SETTINGS_TOOLS].sort()
      )
      for (const tool of PROJECT_SETTINGS_TOOLS) {
        expect(ACCOUNT_SETTINGS_TOOLS.has(tool), tool).to.be.false
      }
    })

    it('handles plan mode', () => {
      expect(decide('plan', 'read_file')).to.equal('allow')
      expect(decide('plan', 'search_text')).to.equal('allow')
      expect(decide('plan', 'compile_project')).to.equal('allow')
      expect(decide('plan', 'get_compile_result')).to.equal('allow')
      expect(decide('plan', 'edit_file')).to.equal('deny')
      expect(decide('plan', 'create_file')).to.equal('deny')
      expect(decide('plan', 'configure_compiler_settings')).to.equal('deny')
      expect(decide('plan', 'present_plan')).to.equal('ask')
      expect(decide('plan', 'unknown_tool')).to.equal('deny')
    })
  })

  describe('modeLabel', () => {
    it('names each mode the way the composer does', () => {
      expect(modeLabel('manual')).to.equal('Manual')
      expect(modeLabel('acceptEdits')).to.equal('Accept edits')
      expect(modeLabel('plan')).to.equal('Plan')
      expect(modeLabel('nonsense')).to.equal('Manual')
    })
  })

  describe('toolSpecsFor', () => {
    const sampleSpecs = [
      { name: 'read_file' },
      { name: 'edit_file' },
      { name: 'create_file' },
      { name: 'configure_editor_settings' },
      { name: 'compile_project' },
    ]

    it('offers the same tools, in the same order, in every mode', () => {
      const manual = toolSpecsFor('manual', sampleSpecs)
      expect(toolSpecsFor('acceptEdits', sampleSpecs)).to.deep.equal(manual)
      expect(toolSpecsFor('plan', sampleSpecs)).to.deep.equal(manual)
      expect(manual.map(s => s.name)).to.deep.equal([
        'read_file',
        'edit_file',
        'create_file',
        'configure_editor_settings',
        'compile_project',
        'present_plan',
      ])
    })

    it('leaves the mode to decide, which refuses what it does not allow', () => {
      expect(decide('plan', 'edit_file')).to.equal('deny')
      expect(decide('plan', 'configure_editor_settings')).to.equal('deny')
      expect(decide('manual', 'present_plan')).to.equal('deny')
      expect(decide('acceptEdits', 'present_plan')).to.equal('deny')
      expect(decide('plan', 'present_plan')).to.equal('ask')
    })
  })
})

describe('AiAssistModePolicy connector tools', function () {
  const MODE_NAMES = ['manual', 'acceptEdits', 'plan']

  it('allows the search and paging tools in every mode, without approval', function () {
    for (const mode of MODE_NAMES) {
      expect(decide(mode, CONNECTOR_SEARCH_TOOL)).to.equal('allow')
      expect(decide(mode, READ_CONNECTOR_RESULT_TOOL)).to.equal('allow')
    }
  })

  it('asks before an ordinary connector tool in the editing modes', function () {
    const readOnly = { readOnly: true, destructive: false }
    expect(decide('manual', 'mcp__docs__search', readOnly)).to.equal('ask')
    expect(decide('acceptEdits', 'mcp__docs__search', readOnly)).to.equal('ask')
    expect(decide('manual', 'mcp__docs__write', {})).to.equal('ask')
  })

  it('denies a blocked connector tool in every mode', function () {
    for (const mode of MODE_NAMES) {
      expect(decide(mode, 'mcp__docs__x', { permission: 'block' })).to.equal('deny')
    }
  })

  it('lets a standing allow run an ordinary connector tool without asking', function () {
    expect(decide('manual', 'mcp__docs__x', { permission: 'allow', readOnly: true })).to.equal('allow')
    expect(decide('acceptEdits', 'mcp__docs__x', { permission: 'allow' })).to.equal('allow')
  })

  it('still asks for a destructive connector tool, even with a standing allow', function () {
    const destructive = { permission: 'allow', destructive: true, readOnly: false }
    expect(decide('manual', 'mcp__docs__delete', destructive)).to.equal('ask')
    expect(decide('acceptEdits', 'mcp__docs__delete', destructive)).to.equal('ask')
  })

  it('denies a connector tool the server does not declare read-only in Plan mode', function () {
    expect(decide('plan', 'mcp__docs__write', { readOnly: false })).to.equal('deny')
    expect(decide('plan', 'mcp__docs__search', { readOnly: true })).to.equal('ask')
    expect(decide('plan', 'mcp__docs__write', { readOnly: false, permission: 'allow' })).to.equal('deny')
  })

  it('recognises connector calls, including the two harness tools, and nothing else', function () {
    expect(isConnectorCallName('mcp__docs__search')).to.be.true
    expect(isConnectorCallName(CONNECTOR_SEARCH_TOOL)).to.be.true
    expect(isConnectorCallName(READ_CONNECTOR_RESULT_TOOL)).to.be.true
    expect(isConnectorCallName('read_file')).to.be.false
    expect(isConnectorCallName(undefined)).to.be.false
  })

  it('offers the connector tools after the built-in ones, with present_plan last', function () {
    const specs = toolSpecsFor('plan', [
      { name: 'read_file' },
      { name: 'mcp__docs__search' },
      { name: CONNECTOR_SEARCH_TOOL },
    ])
    expect(specs.map(spec => spec.name)).to.deep.equal([
      'read_file',
      'mcp__docs__search',
      CONNECTOR_SEARCH_TOOL,
      PLAN_TOOL,
    ])
  })
})

