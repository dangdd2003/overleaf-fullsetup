export const DARK_EDITOR_THEMES = new Set([
  'ambiance',
  'chaos',
  'clouds_midnight',
  'cobalt',
  'dracula',
  'gob',
  'gruvbox',
  'idle_fingers',
  'kr_theme',
  'merbivore',
  'merbivore_soft',
  'mono_industrial',
  'monokai',
  'nord_dark',
  'overleaf_dark',
  'pastel_on_dark',
  'solarized_dark',
  'terminal',
  'tomorrow_night',
  'tomorrow_night_blue',
  'tomorrow_night_bright',
  'tomorrow_night_eighties',
  'twilight',
  'vibrant_ink',
])

export const LIGHT_EDITOR_THEMES = new Set([
  'chrome',
  'clouds',
  'crimson_editor',
  'dawn',
  'dreamweaver',
  'eclipse',
  'github',
  'iplastic',
  'katzenmilch',
  'kuroir',
  'overleaf',
  'solarized_light',
  'sqlserver',
  'textmate',
  'tomorrow',
  'xcode',
])

const EDITOR_USER_KEYS = [
  'mode',
  'autoComplete',
  'autoPairDelimiters',
  'syntaxValidation',
  'pdfViewer',
  'mathPreview',
  'breadcrumbs',
  'editorTabs',
  'spellCheckLanguage',
] as const

export function editorThemeSlots(themeName: string): {
  isDark: boolean
  isLight: boolean
} {
  return {
    isDark:
      DARK_EDITOR_THEMES.has(themeName) ||
      !LIGHT_EDITOR_THEMES.has(themeName),
    isLight:
      LIGHT_EDITOR_THEMES.has(themeName) ||
      !DARK_EDITOR_THEMES.has(themeName),
  }
}

export function normalizeOverallTheme(theme?: string): string {
  if (!theme) return ''
  const lower = String(theme).toLowerCase().trim()
  if (lower === 'dark' || lower === 'default') return ''
  if (lower === 'light' || lower === 'light-') return 'light-'
  if (lower === 'system') return 'system'
  return theme
}

// True when there is no current value to compare against, or it differs
function differs(
  current: Record<string, any> | undefined,
  key: string,
  value: unknown
): boolean {
  return !current || current[key] !== value
}

// Mirrors a boolean setting into localStorage and tells other tabs/listeners
function persistFlag(name: string, value: unknown, projectId?: string) {
  try {
    const val = JSON.stringify(Boolean(value))
    const key = projectId ? `${name}:${projectId}` : name
    if (projectId && typeof localStorage !== 'undefined') {
      localStorage.setItem(`${name}:${projectId}`, val)
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key,
          newValue: val,
        })
      )
    }
  } catch {}
}

export function applyLiveSettingsUpdate(
  toolName: string,
  settings: Record<string, any>,
  options: {
    userSettingsContext?: any
    projectContext?: any
    projectId?: string
  } = {}
) {
  if (!settings || typeof settings !== 'object') return

  const { userSettingsContext, projectContext, projectId } = options
  const currentUserSettings = userSettingsContext?.userSettings
  const currentProject = projectContext?.project

  const isAppearance =
    toolName === 'configure_appearance_settings' ||
    'overallTheme' in settings ||
    'editorTheme' in settings ||
    'editorLightTheme' in settings ||
    'editorDarkTheme' in settings ||
    'darkModePdf' in settings ||
    'fontSize' in settings ||
    'fontFamily' in settings ||
    'lineHeight' in settings

  if (isAppearance) {
    const userPayload: any = {}
    if (settings.overallTheme !== undefined) {
      const norm = normalizeOverallTheme(settings.overallTheme)
      if (differs(currentUserSettings, 'overallTheme', norm)) {
        userPayload.overallTheme = norm
      }
      if (typeof document !== 'undefined' && document.body) {
        document.body.dataset.theme = norm === 'light-' ? 'light' : 'default'
      }
    }
    if (settings.editorTheme !== undefined) {
      const themeName = String(settings.editorTheme)
      if (differs(currentUserSettings, 'editorTheme', themeName)) {
        userPayload.editorTheme = themeName
      }
      const slots = editorThemeSlots(themeName)
      if (
        settings.editorDarkTheme === undefined &&
        slots.isDark &&
        differs(currentUserSettings, 'editorDarkTheme', themeName)
      ) {
        userPayload.editorDarkTheme = themeName
      }
      if (
        settings.editorLightTheme === undefined &&
        slots.isLight &&
        differs(currentUserSettings, 'editorLightTheme', themeName)
      ) {
        userPayload.editorLightTheme = themeName
      }
    }
    if (
      settings.editorLightTheme !== undefined &&
      differs(currentUserSettings, 'editorLightTheme', settings.editorLightTheme)
    ) {
      userPayload.editorLightTheme = settings.editorLightTheme
    }
    if (
      settings.editorDarkTheme !== undefined &&
      differs(currentUserSettings, 'editorDarkTheme', settings.editorDarkTheme)
    ) {
      userPayload.editorDarkTheme = settings.editorDarkTheme
    }
    if (settings.fontSize !== undefined) {
      const val = Number(settings.fontSize)
      if (differs(currentUserSettings, 'fontSize', val)) {
        userPayload.fontSize = val
      }
    }
    if (
      settings.fontFamily !== undefined &&
      differs(currentUserSettings, 'fontFamily', settings.fontFamily)
    ) {
      userPayload.fontFamily = settings.fontFamily
    }
    if (
      settings.lineHeight !== undefined &&
      differs(currentUserSettings, 'lineHeight', settings.lineHeight)
    ) {
      userPayload.lineHeight = settings.lineHeight
    }
    if (settings.darkModePdf !== undefined) {
      const val = Boolean(settings.darkModePdf)
      if (differs(currentUserSettings, 'darkModePdf', val)) {
        userPayload.darkModePdf = val
      }
      if (projectId && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(`pdf_dark_mode:${projectId}`, String(settings.darkModePdf))
        } catch {}
      }
    }

    if (Object.keys(userPayload).length > 0 && userSettingsContext?.setUserSettings) {
      try {
        userSettingsContext.setUserSettings((prev: any) => ({ ...prev, ...userPayload }))
      } catch {}
    }
  }

  const isCompiler =
    toolName === 'configure_compiler_settings' ||
    'compiler' in settings ||
    'imageName' in settings ||
    'rootDocPath' in settings ||
    'rootDocId' in settings ||
    'draft' in settings ||
    'stopOnFirstError' in settings

  if (isCompiler) {
    const projectPayload: any = {}
    if (
      settings.compiler !== undefined &&
      differs(currentProject, 'compiler', settings.compiler)
    ) {
      projectPayload.compiler = settings.compiler
    }
    if (
      settings.imageName !== undefined &&
      differs(currentProject, 'imageName', settings.imageName)
    ) {
      projectPayload.imageName = settings.imageName
    }
    if (
      settings.rootDocId !== undefined &&
      differs(currentProject, 'rootDocId', settings.rootDocId)
    ) {
      projectPayload.rootDocId = settings.rootDocId
    }
    if (
      settings.rootDocPath !== undefined &&
      differs(currentProject, 'rootDocPath', settings.rootDocPath)
    ) {
      projectPayload.rootDocPath = settings.rootDocPath
    }

    if (Object.keys(projectPayload).length > 0 && projectContext?.updateProject) {
      try {
        projectContext.updateProject(projectPayload)
      } catch {}
    }

    if (settings.draft !== undefined) {
      persistFlag('draft', settings.draft, projectId)
    }
    if (settings.stopOnFirstError !== undefined) {
      persistFlag('stop_on_first_error', settings.stopOnFirstError, projectId)
    }
  }

  const isEditor =
    toolName === 'configure_editor_settings' ||
    EDITOR_USER_KEYS.some(k => k in settings)

  if (isEditor) {
    const userPayload: any = {}
    for (const k of EDITOR_USER_KEYS) {
      if (settings[k] !== undefined && differs(currentUserSettings, k, settings[k])) {
        userPayload[k] = settings[k]
      }
    }
    if (Object.keys(userPayload).length > 0 && userSettingsContext?.setUserSettings) {
      try {
        userSettingsContext.setUserSettings((prev: any) => ({ ...prev, ...userPayload }))
      } catch {}
    }
    if (
      settings.spellCheckLanguage !== undefined &&
      (!currentProject || currentProject.spellCheckLanguage !== settings.spellCheckLanguage) &&
      projectContext?.updateProject
    ) {
      try {
        projectContext.updateProject({ spellCheckLanguage: settings.spellCheckLanguage })
      } catch {}
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('aiAssist:settingsUpdated', {
        detail: { toolName, settings },
      })
    )
  }
}
