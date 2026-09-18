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
    const [index, settings] = await Promise.all([
      handle.index(),
      handle.getProjectSettings().catch(() => null),
    ])
    return {
      documentClass: index.outline.documentClass,
      compiler: settings?.compiler?.compiler ?? 'pdflatex',
      imageName: settings?.compiler?.imageName ?? null,
      packages: index.packages,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.packages) {
      const header = [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        `compiler: ${result.compiler ?? 'unknown'}${result.imageName ? ` (${result.imageName})` : ''}`,
      ]
      const pkgLines = result.packages.map((pkg: any) => {
        const optStr = pkg.options ? ` [${pkg.options}]` : ''
        return `${pkg.name}${optStr}  (${pkg.path}:${pkg.line})`
      })
      return [...header, ...pkgLines].join('\n')
    }

    return JSON.stringify(result)
  },
}
