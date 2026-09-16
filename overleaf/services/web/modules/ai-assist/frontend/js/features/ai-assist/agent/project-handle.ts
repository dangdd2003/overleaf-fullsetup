import { ProjectIndex } from './context/project-index'

export type ProjectFile = {
  path: string
  type: 'doc' | 'binary'
  size: number
  /** Line count for docs; undefined for binaries. Models pick ranges by line. */
  lines?: number
}

export type LogEntrySummary = {
  message: string
  file: string | null
  line: number | null
}

export type EditRequest = {
  path: string
  oldText: string
  newText: string
}

export type EditOutcome =
  | { status: 'applied'; startLine?: number }
  | { status: 'rejected'; note?: string }
  | { status: 'noMatch' }
  | { status: 'ambiguous'; matches: number }
  | { status: 'drifted' }

export type SearchHit = { path: string; line: number; text: string }

export type CompileOutcome = {
  status: string
  errors: LogEntrySummary[]
  warnings: LogEntrySummary[]
}

/** The last compile, including the raw log `get_compile_log` excerpts from. */
export type LastCompile = CompileOutcome & { rawLog: string | null }

export type AppearanceSettings = {
  overallTheme?: string
  editorTheme?: string
  editorLightTheme?: string
  editorDarkTheme?: string
  darkModePdf?: boolean
  fontSize?: number
  fontFamily?: string | null
  lineHeight?: string | null
}

export type CompilerSettings = {
  compiler?: string
  imageName?: string | null
  rootDocPath?: string | null
  rootDocId?: string | null
  draft?: boolean
  stopOnFirstError?: boolean
}

export type EditorSettings = {
  mode?: string
  autoComplete?: boolean
  autoPairDelimiters?: boolean
  syntaxValidation?: boolean
  pdfViewer?: string
  mathPreview?: boolean
  breadcrumbs?: boolean
  editorTabs?: boolean
  spellCheckLanguage?: string
}

export type ProjectSettingsSummary = {
  compiler: CompilerSettings
  appearance: AppearanceSettings
  editor: EditorSettings
  spelling: {
    spellCheckLanguage?: string | null
  }
  name?: string
  description?: string
}

export type AvailableSettingsOptions = {
  compilers: string[]
  imageNames?: Array<{ imageName: string; imageDesc?: string; default?: boolean }>
  spellCheckLanguages: Array<{ code: string; name: string }>
  editorModes: string[]
  overallThemes: string[]
  editorThemes?: Array<{ name: string; label?: string; dark: boolean }>
  fontFamilies?: Array<{ name: string; label: string }>
  lineHeights: string[]
  fontSizes: number[]
  pdfViewers: string[]
}

/**
 * Everything the agent is allowed to do to a project.
 *
 * Tools depend on this and nothing else, which is what keeps them testable
 * without React, a DOM, or a network.
 */
export interface ProjectHandle {
  rootDocPath(): string | null
  listFiles(): Promise<ProjectFile[]>
  readFile(
    path: string,
    range?: { from: number; to: number }
  ): Promise<{ lines: string[]; truncated: boolean }>
  search(
    query: string,
    options?: { caseSensitive?: boolean; regexp?: boolean }
  ): Promise<SearchHit[]>
  currentSelection(): {
    path: string
    from: number
    to: number
    text: string
  } | null
  proposeEdit(edit: EditRequest): Promise<EditOutcome>
  compile(): Promise<CompileOutcome>
  /** The document the user is looking at, if any. */
  openFile(): { path: string; cursorLine: number | null } | null
  /** The last compile result, without triggering a new one. */
  lastCompile(): LastCompile | null
  /**
   * The structural index over every document file: section tree, reference
   * resolution, environment inventory. Built in the browser from the project
   * snapshot; referentially stable while nothing changes.
   */
  index(): Promise<ProjectIndex>
  /** Create a file that does not exist yet, behind the same approval card. */
  createFile(request: { path: string; content: string }): Promise<EditOutcome>
  /** Read current project settings summary across compiler, appearance, editor, and spelling. */
  getProjectSettings(): Promise<ProjectSettingsSummary>
  /** Update appearance preferences (overall theme, editor theme, dark mode PDF, font size, etc.). */
  configureAppearanceSettings(
    settings: Partial<AppearanceSettings>
  ): Promise<{ status: 'applied'; updatedSettings: Partial<AppearanceSettings>; message?: string }>
  /** Update compiler settings (engine, TeX Live version, root doc, draft, stop-on-first-error). */
  configureCompilerSettings(
    settings: Partial<CompilerSettings>
  ): Promise<{ status: 'applied'; updatedSettings: Partial<CompilerSettings>; message?: string }>
  /** Update editor preferences (keybindings, auto-complete, bracket pairing, PDF viewer, etc.). */
  configureEditorSettings(
    settings: Partial<EditorSettings>
  ): Promise<{ status: 'applied'; updatedSettings: Partial<EditorSettings>; message?: string }>
  /** List valid options and enums for project and editor settings. */
  listAvailableSettings(): Promise<AvailableSettingsOptions>
}

export const MAX_READ_LINES = 1000
export const MAX_SEARCH_HITS = 50
