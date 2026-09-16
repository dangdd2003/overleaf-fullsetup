import { AgentTool } from './registry'

export const listAvailableSettingsTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'list_available_settings',
    description:
      'List all allowed and available options for project and editor settings: available LaTeX compilers, TeX Live versions, supported spell-check languages, keybinding modes, overall themes, editor syntax themes, code fonts (fontFamilies), line heights, font sizes, and PDF viewers.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  async execute(_args, handle) {
    try {
      const options = await handle.listAvailableSettings()
      return {
        status: 'ok',
        options,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'Failed to list available settings options.' }
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)
    if (result?.options) {
      const o = result.options
      const themeNames = Array.isArray(o.editorThemes)
        ? o.editorThemes.map((t: any) => (typeof t === 'string' ? t : t.name))
        : []
      const fontNames = Array.isArray(o.fontFamilies)
        ? o.fontFamilies.map((f: any) => (typeof f === 'string' ? f : `${f.name} (${f.label})`))
        : []
      const lines = [
        `Compilers: ${(o.compilers || []).join(', ')}`,
        `TeX Live Versions: ${(o.imageNames || []).map((img: any) => img.imageName).join(', ')}`,
        `Keybinding Modes: ${(o.editorModes || []).join(', ')}`,
        `Themes: ${(o.overallThemes || []).join(', ')}`,
        themeNames.length > 0 ? `Editor Themes: ${themeNames.join(', ')}` : '',
        fontNames.length > 0 ? `Code Fonts: ${fontNames.join(', ')}` : '',
        `Line Heights: ${(o.lineHeights || []).join(', ')}`,
        `Languages: ${(o.spellCheckLanguages || []).slice(0, 8).map((l: any) => `${l.code} (${l.name})`).join(', ')}...`,
      ].filter(Boolean)
      return lines.join('\n')
    }
    return JSON.stringify(result)
  },
}
