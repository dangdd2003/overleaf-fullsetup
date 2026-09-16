import { AgentTool } from './registry'

export const configureEditorSettingsTool: AgentTool = {
  suspends: false,
  mutates: true,
  spec: {
    name: 'configure_editor_settings',
    description:
      'Configure editor behavior preferences: keybinding mode (none, vim, emacs), auto-complete, auto-closing brackets, syntax validation, PDF viewer, math preview, breadcrumbs, editor tabs, and spellcheck language. Account settings cannot be changed here.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['none', 'vim', 'emacs'],
          description: 'Keybinding mode',
        },
        autoComplete: {
          type: 'boolean',
          description: 'Toggle auto-complete popup suggestions',
        },
        autoPairDelimiters: {
          type: 'boolean',
          description: 'Toggle auto-closing of brackets and quotes',
        },
        syntaxValidation: {
          type: 'boolean',
          description: 'Toggle LaTeX syntax validation',
        },
        pdfViewer: {
          type: 'string',
          enum: ['pdfjs', 'native'],
          description: 'PDF viewer mode',
        },
        mathPreview: {
          type: 'boolean',
          description: 'Toggle inline math preview tooltip',
        },
        breadcrumbs: {
          type: 'boolean',
          description: 'Toggle file breadcrumbs bar',
        },
        editorTabs: {
          type: 'boolean',
          description: 'Toggle editor tabs bar',
        },
        spellCheckLanguage: {
          type: 'string',
          description: 'Default user spell-check language code (e.g. "en", "fr")',
        },
      },
      required: [],
    },
  },

  async execute(args, handle) {
    if (!args || Object.keys(args).length === 0) {
      return { error: 'Supply at least one editor setting to configure.' }
    }

    try {
      const outcome = await handle.configureEditorSettings(args)
      return {
        status: outcome.status,
        updatedSettings: outcome.updatedSettings,
        message: outcome.message || 'Editor settings updated successfully.',
      }
    } catch (error: any) {
      return { error: error?.message ?? 'Failed to update editor settings.' }
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated editor settings (${keys.join(', ')}): ${result.message || 'applied'}`
    }
    return JSON.stringify(result)
  },
}
