import {
  AppearanceSettings,
  AvailableSettingsOptions,
  CompileOptions,
  CompilerSettings,
  EditOutcome,
  EditRequest,
  EditorSettings,
  LastCompile,
  ProjectHandle,
  ProjectSettingsSummary,
  SearchHit,
} from '../../../../../frontend/js/features/ai-assist/agent/project-handle'
import { buildProjectIndex, ProjectIndex } from '../../../../../frontend/js/features/ai-assist/agent/context/project-index'
import { matchesGlob } from '../../../../../frontend/js/features/ai-assist/agent/tools/search-text'

export type FakeHandleOptions = {
  docs?: Record<string, string>
  binaries?: string[]
  rootDoc?: string | null
  selection?: { path: string; from: number; to: number; text: string } | null
  onEdit?: (edit: EditRequest) => EditOutcome
  compileResult?: Awaited<ReturnType<ProjectHandle['compile']>>
  openFile?: { path: string; cursorLine: number | null } | null
  lastCompile?: LastCompile | null
  onCreate?: (request: { path: string; content: string }) => EditOutcome
  projectSettingsSummary?: ProjectSettingsSummary
  compilerSettings?: CompilerSettings
  appearanceSettings?: AppearanceSettings
  editorSettings?: EditorSettings
  availableSettings?: AvailableSettingsOptions
}

/** A ProjectHandle backed by a plain object, for tests that need no DOM. */
export function createFakeHandle(options: FakeHandleOptions = {}) {
  const docs = options.docs ?? {}
  const calls: Array<{ name: string; args: unknown }> = []
  const approvalContexts: Array<{ startLine: number }> = []
  let cachedIndex: ProjectIndex | null = null

  let currentCompilerSettings: CompilerSettings = options.compilerSettings ??
    options.projectSettingsSummary?.compiler ?? {
      compiler: 'pdflatex',
      imageName: 'texlive-2024.1',
      rootDocPath: options.rootDoc ?? Object.keys(docs)[0] ?? 'main.tex',
      rootDocId: 'doc-1',
      draft: false,
      stopOnFirstError: false,
    }

  let currentAppearanceSettings: AppearanceSettings = options.appearanceSettings ??
    options.projectSettingsSummary?.appearance ?? {
      overallTheme: 'system',
      editorTheme: 'textmate',
      editorLightTheme: 'textmate',
      editorDarkTheme: 'overleaf_dark',
      darkModePdf: false,
      fontSize: 12,
      fontFamily: null,
      lineHeight: 'normal',
    }

  let currentEditorSettings: EditorSettings = options.editorSettings ??
    options.projectSettingsSummary?.editor ?? {
      mode: 'none',
      autoComplete: true,
      autoPairDelimiters: true,
      syntaxValidation: true,
      pdfViewer: 'pdfjs',
      mathPreview: true,
      breadcrumbs: true,
      editorTabs: true,
      spellCheckLanguage: 'en',
    }

  let currentSpelling = options.projectSettingsSummary?.spelling ?? {
    spellCheckLanguage: 'en',
  }

  let projectName = options.projectSettingsSummary?.name ?? 'Sample Project'
  let projectDescription = options.projectSettingsSummary?.description ?? ''

  const handle: ProjectHandle = {
    rootDocPath: () => currentCompilerSettings.rootDocPath ?? options.rootDoc ?? Object.keys(docs)[0] ?? null,

    async listFiles() {
      calls.push({ name: 'listFiles', args: null })
      return [
        ...Object.entries(docs).map(([path, text]) => ({
          path,
          type: 'doc' as const,
          size: text.length,
          lines: text.split('\n').length,
        })),
        ...(options.binaries ?? []).map(path => ({
          path,
          type: 'binary' as const,
          size: 0,
        })),
      ]
    },

    async readFile(path, range) {
      calls.push({ name: 'readFile', args: { path, range } })
      const text = docs[path]
      if (text === undefined) throw new Error(`no such doc: ${path}`)
      const lines = text.split('\n')
      if (!range) return { lines, truncated: false }
      return { lines: lines.slice(range.from - 1, range.to), truncated: false }
    },

    async search(query, options) {
      calls.push({ name: 'search', args: { query, options } })
      const hits: SearchHit[] = []
      const pattern = options?.glob
      for (const [path, text] of Object.entries(docs)) {
        if (pattern && !matchesGlob(path.replace(/^\//, ''), pattern)) continue
        text.split('\n').forEach((line, index) => {
          if (line.includes(query)) hits.push({ path, line: index + 1, text: line })
        })
      }
      return hits
    },

    currentSelection: () => options.selection ?? null,

    async proposeEdit(edit) {
      calls.push({ name: 'proposeEdit', args: edit })
      const text = docs[edit.path] ?? ''
      const index = text.indexOf(edit.oldText)
      if (index !== -1) {
        approvalContexts.push({
          startLine: text.slice(0, index).split('\n').length,
        })
      }
      return options.onEdit ? options.onEdit(edit) : { status: 'applied' }
    },

    async compile(compileOptions?: CompileOptions) {
      calls.push({ name: 'compile', args: compileOptions ?? null })
      return (
        options.compileResult ?? { status: 'success', errors: [], warnings: [] }
      )
    },

    openFile: () => options.openFile ?? null,

    lastCompile: () => options.lastCompile ?? null,

    async index() {
      cachedIndex = buildProjectIndex(
        { docs: { ...docs }, rootPath: options.rootDoc ?? null },
        cachedIndex
      )
      return cachedIndex
    },

    async createFile(request) {
      calls.push({ name: 'createFile', args: request })
      return options.onCreate ? options.onCreate(request) : { status: 'applied' }
    },

    async getProjectSettings() {
      calls.push({ name: 'getProjectSettings', args: null })
      return {
        compiler: currentCompilerSettings,
        appearance: currentAppearanceSettings,
        editor: currentEditorSettings,
        spelling: currentSpelling,
        name: projectName,
        description: projectDescription,
      }
    },

    async configureAppearanceSettings(settings: Partial<AppearanceSettings>) {
      calls.push({ name: 'configureAppearanceSettings', args: settings })
      currentAppearanceSettings = { ...currentAppearanceSettings, ...settings }
      return { status: 'applied', updatedSettings: settings, message: 'Appearance settings updated.' }
    },

    async configureCompilerSettings(settings: Partial<CompilerSettings>) {
      calls.push({ name: 'configureCompilerSettings', args: settings })
      currentCompilerSettings = { ...currentCompilerSettings, ...settings }
      return { status: 'applied', updatedSettings: settings, message: 'Compiler settings updated.' }
    },

    async configureEditorSettings(settings: Partial<EditorSettings>) {
      calls.push({ name: 'configureEditorSettings', args: settings })
      currentEditorSettings = { ...currentEditorSettings, ...settings }
      return { status: 'applied', updatedSettings: settings, message: 'Editor settings updated.' }
    },

    async listAvailableSettings() {
      calls.push({ name: 'listAvailableSettings', args: null })
      return (
        options.availableSettings ?? {
          compilers: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
          imageNames: [{ imageName: 'texlive-2024.1', imageDesc: 'TeX Live 2024', default: true }],
          spellCheckLanguages: [
            { code: 'en', name: 'English' },
            { code: 'fr', name: 'French' },
            { code: 'de', name: 'German' },
          ],
          editorModes: ['none', 'vim', 'emacs'],
          overallThemes: ['system', 'light', 'dark'],
          fontFamilies: [
            { name: 'monaco', label: 'Monaco / Menlo / Consolas' },
            { name: 'lucida', label: 'Lucida / Source Code Pro' },
            { name: 'opendyslexicmono', label: 'OpenDyslexic Mono' },
          ],
          lineHeights: ['compact', 'normal', 'spacious'],
          fontSizes: [10, 11, 12, 13, 14, 16, 18, 20, 24],
          pdfViewers: ['pdfjs', 'native'],
        }
      )
    },
  }

  return { handle, calls, approvalContexts }
}
