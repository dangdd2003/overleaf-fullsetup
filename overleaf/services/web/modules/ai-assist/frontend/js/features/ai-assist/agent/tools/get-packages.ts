import { AgentTool } from './registry'

export const getPackagesTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_packages',
    description:
      "The documentclass and every \\usepackage in the project, with the file and line that loads it. Use this to check whether a command's package is available before assuming it is missing.",
    parameters: { type: 'object', properties: {}, required: [] },
  },

  async execute(_args = {}, handle) {
    const index = await handle.index()
    return {
      documentClass: index.outline.documentClass,
      packages: index.packages,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.packages) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.packages.map(
          (pkg: any) => `${pkg.name}  (${pkg.path}:${pkg.line})`
        ),
      ].join('\n')
    }

    return JSON.stringify(result)
  },
}
