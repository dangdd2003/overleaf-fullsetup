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

    it('offers edit tools in manual mode', () => {
      const specs = toolSpecsFor('manual', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members([
        'read_file',
        'edit_file',
        'create_file',
        'configure_editor_settings',
      ])
      expect(names).not.to.include('present_plan')
    })

    it('offers edit tools in acceptEdits mode', () => {
      const specs = toolSpecsFor('acceptEdits', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members([
        'read_file',
        'edit_file',
        'create_file',
        'configure_editor_settings',
      ])
      expect(names).not.to.include('present_plan')
    })

    it('excludes edit tools and includes present_plan in plan mode', () => {
      const specs = toolSpecsFor('plan', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'compile_project', 'present_plan'])
      expect(names).not.to.include('edit_file')
      expect(names).not.to.include('create_file')
      expect(names).not.to.include('configure_editor_settings')
    })
  })
})
