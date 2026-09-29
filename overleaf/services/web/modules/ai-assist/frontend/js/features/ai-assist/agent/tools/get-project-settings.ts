import { AgentTool } from './registry'

export const getProjectSettingsTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_project_settings',
    description:
      'Read current project settings and preferences organized by tab: compiler (engine, TeX Live version, root doc), appearance (themes, font size, line height, dark mode PDF), editor (keybindings, auto-complete, bracket pairing, syntax validation, PDF viewer), and spelling.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  async execute(_args, handle) {
    try {
      const settings = await handle.getProjectSettings()
      return {
        status: 'ok',
        settings,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'Failed to retrieve project settings.' }
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)
    if (result?.settings) {
      const { compiler, appearance, editor, spelling, name, description } = result.settings
      const lines: string[] = []
      if (name) lines.push(`Project Name: ${name}`)
      if (description) lines.push(`Description: ${description}`)

      if (compiler) {
        lines.push('--- Compiler Settings ---')
        lines.push(`Compiler: ${compiler.compiler || 'pdflatex'}`)
        lines.push(`TeX Live: ${compiler.imageName || 'default'}`)
        lines.push(`Root Document: ${compiler.rootDocPath || compiler.rootDocId || '(none)'}`)
        if (compiler.draft) lines.push(`Draft: true`)
        if (compiler.stopOnFirstError) lines.push(`Stop on First Error: true`)
      }

      if (appearance) {
        lines.push('--- Appearance Settings ---')
        lines.push(`Theme: ${appearance.editorTheme || 'textmate'} (UI: ${appearance.overallTheme || 'system'})`)
        lines.push(`Font Size: ${appearance.fontSize ?? 12}px`)
        if (appearance.fontFamily) lines.push(`Font Family: ${appearance.fontFamily}`)
        if (appearance.lineHeight) lines.push(`Line Spacing: ${appearance.lineHeight}`)
        lines.push(`Dark Mode PDF: ${appearance.darkModePdf ? 'enabled' : 'disabled'}`)
      }

      if (editor) {
        lines.push('--- Editor Settings ---')
        lines.push(`Keybindings: ${editor.mode || 'none'}`)
        lines.push(`Auto-complete: ${editor.autoComplete ? 'enabled' : 'disabled'}`)
        lines.push(`Auto-close Brackets: ${editor.autoPairDelimiters ? 'enabled' : 'disabled'}`)
        lines.push(`Syntax Validation: ${editor.syntaxValidation ? 'enabled' : 'disabled'}`)
        lines.push(`PDF Viewer: ${editor.pdfViewer || 'pdfjs'}`)
        lines.push(`Math Preview: ${editor.mathPreview ? 'enabled' : 'disabled'}`)
        lines.push(`Breadcrumbs: ${editor.breadcrumbs ? 'enabled' : 'disabled'}`)
        lines.push(`Editor Tabs: ${editor.editorTabs ? 'enabled' : 'disabled'}`)
      }

      if (spelling?.spellCheckLanguage) {
        lines.push(`Spellcheck: ${spelling.spellCheckLanguage}`)
      }

      return lines.join('\n')
    }
    return JSON.stringify(result)
  },
}
