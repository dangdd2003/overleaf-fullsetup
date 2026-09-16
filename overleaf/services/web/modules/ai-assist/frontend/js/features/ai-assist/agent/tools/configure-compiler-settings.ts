import { AgentTool } from './registry'

export const configureCompilerSettingsTool: AgentTool = {
  suspends: false,
  mutates: true,
  spec: {
    name: 'configure_compiler_settings',
    description:
      'Configure compiler settings: LaTeX compiler engine (pdflatex, latex, xelatex, lualatex), TeX Live version image, root document path, draft mode, and stop on first error.',
    parameters: {
      type: 'object',
      properties: {
        compiler: {
          type: 'string',
          enum: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
          description: 'LaTeX compiler engine',
        },
        imageName: {
          type: 'string',
          description: 'TeX Live version/image name (e.g. "texlive-2024.1")',
        },
        rootDocPath: {
          type: 'string',
          description: 'Path of the root document, e.g. main.tex',
        },
        draft: {
          type: 'boolean',
          description: 'Toggle draft mode compilation (faster builds by omitting images)',
        },
        stopOnFirstError: {
          type: 'boolean',
          description: 'Toggle stopping compilation immediately on the first error',
        },
      },
      required: [],
    },
  },

  async execute(args, handle) {
    if (!args || Object.keys(args).length === 0) {
      return { error: 'Supply at least one compiler setting to configure.' }
    }

    try {
      const outcome = await handle.configureCompilerSettings(args)
      return {
        status: outcome.status,
        updatedSettings: outcome.updatedSettings,
        message: outcome.message || 'Compiler settings updated successfully.',
      }
    } catch (error: any) {
      return { error: error?.message ?? 'Failed to update compiler settings.' }
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated compiler settings (${keys.join(', ')}): ${result.message || 'applied'}`
    }
    return JSON.stringify(result)
  },
}
