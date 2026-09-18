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
  PLAN_TOOL,
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

  describe('toolSpecsFor', () => {
    const sampleSpecs = [
      { name: 'read_file' },
      { name: 'edit_file' },
      { name: 'create_file' },
      { name: 'configure_editor_settings' },
      { name: 'compile_project' },
    ]

    it('returns all specs and excludes present_plan for manual mode', () => {
      const specs = toolSpecsFor('manual', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'edit_file', 'create_file', 'configure_editor_settings', 'compile_project'])
      expect(names).to.not.include('present_plan')
    })

    it('returns all specs and excludes present_plan for acceptEdits mode', () => {
      const specs = toolSpecsFor('acceptEdits', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'edit_file', 'create_file', 'configure_editor_settings', 'compile_project'])
      expect(names).to.not.include('present_plan')
    })

    it('excludes edit and settings tools and includes present_plan for plan mode', () => {
      const specs = toolSpecsFor('plan', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'compile_project', 'present_plan'])
      expect(names).to.not.include('edit_file')
      expect(names).to.not.include('create_file')
      expect(names).to.not.include('configure_editor_settings')
      expect(specs.find(s => s.name === 'present_plan')).to.deep.equal(PRESENT_PLAN_SPEC)
    })
  })
})
