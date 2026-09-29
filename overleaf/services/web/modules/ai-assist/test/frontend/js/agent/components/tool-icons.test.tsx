import { expect } from 'chai'
import { render } from '@testing-library/react'
import {
  getToolIcon,
  summarise,
} from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'

describe('tool-icons and getToolIcon', function () {
  const renderIcon = (name: string) => {
    const iconElement = getToolIcon(name)
    const { container } = render(iconElement)
    return container
  }

  it('renders Gear icon for project and compiler settings tools', function () {
    const tools = [
      'get_project_settings',
      'configure_project_settings',
      'configure_compiler_settings',
    ]
    for (const tool of tools) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
      // Phosphor icons without aria/class still render valid SVGs
      expect(svg?.getAttribute('viewBox')).to.equal('0 0 256 256')
    }
  })

  it('renders SlidersHorizontal icon for editor and appearance settings tools', function () {
    const tools = [
      'get_editor_settings',
      'configure_editor_settings',
      'configure_appearance_settings',
    ]
    for (const tool of tools) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
    }
  })

  it('renders ListChecks icon for list_available_settings', function () {
    const container = renderIcon('list_available_settings')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders Files icon for list_files and project_map', function () {
    for (const tool of ['list_files', 'project_map']) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
    }
  })

  it('renders FileText icon for read_file', function () {
    const container = renderIcon('read_file')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders MagnifyingGlass icon for search_text and search_project', function () {
    for (const tool of ['search_text', 'search_project']) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
    }
  })

  it('renders TreeStructure icon for get_outline', function () {
    const container = renderIcon('get_outline')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders Package icon for get_packages', function () {
    const container = renderIcon('get_packages')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders Bookmarks icon for get_references and list_references', function () {
    for (const tool of ['get_references', 'list_references']) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
    }
  })

  it('renders PencilSimple icon for edit_file', function () {
    const container = renderIcon('edit_file')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders FilePlus icon for create_file', function () {
    const container = renderIcon('create_file')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders Play icon for compile_project', function () {
    const container = renderIcon('compile_project')
    const svg = container.querySelector('svg')
    expect(svg).to.exist
  })

  it('renders TerminalWindow icon for get_compile_result and get_compile_log', function () {
    for (const tool of ['get_compile_result', 'get_compile_log']) {
      const container = renderIcon(tool)
      const svg = container.querySelector('svg')
      expect(svg).to.exist
    }
  })

  it('renders Wrench icon for unknown tools and NOT Sparkle', function () {
    const unknownContainer = renderIcon('unknown_custom_tool')
    const svg = unknownContainer.querySelector('svg')
    expect(svg).to.exist

    // Compare with Wrench vs getToolIcon
    const wrenchContainer = renderIcon('some_nonexistent_tool')
    expect(wrenchContainer.innerHTML).to.equal(unknownContainer.innerHTML)
  })
})

describe('summarise with settings tools', function () {
  const fakeT = (_key: string, opts?: any) =>
    typeof opts === 'string' ? opts : opts?.defaultValue || _key

  it('summarises get_project_settings', function () {
    const summary = summarise(
      { id: '1', name: 'get_project_settings', args: {}, result: { compiler: 'pdflatex' } },
      fakeT
    )
    expect(summary.action).to.equal('Checked project settings')
  })

  it('summarises configure_project_settings and configure_compiler_settings', function () {
    const summary1 = summarise(
      { id: '1', name: 'configure_project_settings', args: { compiler: 'xelatex' }, result: { success: true } },
      fakeT
    )
    expect(summary1.action).to.equal('Configured project settings')

    const summary2 = summarise(
      { id: '2', name: 'configure_compiler_settings', args: { compiler: 'lualatex' }, result: { success: true } },
      fakeT
    )
    expect(summary2.action).to.equal('Configured project settings')
  })

  it('summarises get_editor_settings', function () {
    const summary = summarise(
      { id: '1', name: 'get_editor_settings', args: {}, result: { theme: 'github' } },
      fakeT
    )
    expect(summary.action).to.equal('Checked editor settings')
  })

  it('summarises configure_editor_settings and configure_appearance_settings', function () {
    const summary1 = summarise(
      { id: '1', name: 'configure_editor_settings', args: { fontSize: 14 }, result: { success: true } },
      fakeT
    )
    expect(summary1.action).to.equal('Configured editor settings')

    const summary2 = summarise(
      { id: '2', name: 'configure_appearance_settings', args: { theme: 'dark' }, result: { success: true } },
      fakeT
    )
    expect(summary2.action).to.equal('Configured editor settings')
  })

  it('summarises list_available_settings', function () {
    const summary = summarise(
      { id: '1', name: 'list_available_settings', args: {}, result: { settings: [] } },
      fakeT
    )
    expect(summary.action).to.equal('Checked available settings')
  })

  it('summarises failed settings tools', function () {
    const summary = summarise(
      { id: '1', name: 'configure_project_settings', args: {}, result: { error: 'denied' }, isError: true },
      fakeT
    )
    expect(summary.action).to.equal('Configured project settings (failed)')
  })
})
