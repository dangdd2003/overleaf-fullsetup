import { AgentTool } from './registry'

export const configureAppearanceSettingsTool: AgentTool = {
  suspends: false,
  mutates: true,
  spec: {
    name: 'configure_appearance_settings',
    description:
      'Configure appearance and UI display preferences: overall theme (system, light, dark), editor syntax themes, font size, font family, line height, and dark mode PDF preview.',
    parameters: {
      type: 'object',
      properties: {
        overallTheme: {
          type: 'string',
          enum: ['system', 'light', 'dark'],
          description: 'Overall UI theme',
        },
        editorTheme: {
          type: 'string',
          description:
            'Editor syntax theme (e.g. "overleaf", "overleaf_dark", "monokai", "dracula", "github", "nord_dark", "solarized_dark", "solarized_light", "textmate")',
        },
        editorLightTheme: {
          type: 'string',
          description: 'Editor syntax theme for light mode',
        },
        editorDarkTheme: {
          type: 'string',
          description: 'Editor syntax theme for dark mode',
        },
        darkModePdf: {
          type: 'boolean',
          description: 'Toggle dark mode PDF preview',
        },
        fontSize: {
          type: 'number',
          description: 'Editor font size in pixels (e.g. 10 to 24)',
        },
        fontFamily: {
          type: 'string',
          enum: ['monaco', 'lucida', 'opendyslexicmono'],
          description:
            'Editor code font family: "monaco" (Monaco / Menlo / Consolas), "lucida" (Lucida / Source Code Pro), or "opendyslexicmono" (OpenDyslexic Mono)',
        },
        lineHeight: {
          type: 'string',
          enum: ['compact', 'normal', 'spacious'],
          description: 'Editor line spacing',
        },
      },
      required: [],
    },
  },

  async execute(args, handle) {
    if (!args || Object.keys(args).length === 0) {
      return { error: 'Supply at least one appearance setting to configure.' }
    }

    try {
      const outcome = await handle.configureAppearanceSettings(args)
      return {
        status: outcome.status,
        updatedSettings: outcome.updatedSettings,
        message: outcome.message || 'Appearance settings updated successfully.',
      }
    } catch (error: any) {
      return { error: error?.message ?? 'Failed to update appearance settings.' }
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated appearance settings (${keys.join(', ')}): ${result.message || 'applied'}`
    }
    return JSON.stringify(result)
  },
}
