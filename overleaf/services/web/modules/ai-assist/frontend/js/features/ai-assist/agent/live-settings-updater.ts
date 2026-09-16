export function normalizeOverallTheme(theme?: string): string {
  if (!theme) return ''
  const lower = String(theme).toLowerCase().trim()
  if (lower === 'dark' || lower === 'default') return ''
  if (lower === 'light' || lower === 'light-') return 'light-'
  if (lower === 'system') return 'system'
  return theme
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
      if (!currentUserSettings || currentUserSettings.overallTheme !== norm) {
        userPayload.overallTheme = norm
      }
      if (typeof document !== 'undefined' && document.body) {
        document.body.dataset.theme = norm === 'light-' ? 'light' : 'default'
      }
    }
    if (
      settings.editorTheme !== undefined &&
      (!currentUserSettings || currentUserSettings.editorTheme !== settings.editorTheme)
    ) {
      userPayload.editorTheme = settings.editorTheme
    }
    if (
      settings.editorLightTheme !== undefined &&
      (!currentUserSettings || currentUserSettings.editorLightTheme !== settings.editorLightTheme)
    ) {
      userPayload.editorLightTheme = settings.editorLightTheme
    }
    if (
      settings.editorDarkTheme !== undefined &&
      (!currentUserSettings || currentUserSettings.editorDarkTheme !== settings.editorDarkTheme)
    ) {
      userPayload.editorDarkTheme = settings.editorDarkTheme
    }
    if (settings.fontSize !== undefined) {
      const val = Number(settings.fontSize)
      if (!currentUserSettings || currentUserSettings.fontSize !== val) {
        userPayload.fontSize = val
      }
    }
    if (
      settings.fontFamily !== undefined &&
      (!currentUserSettings || currentUserSettings.fontFamily !== settings.fontFamily)
    ) {
      userPayload.fontFamily = settings.fontFamily
    }
    if (
      settings.lineHeight !== undefined &&
      (!currentUserSettings || currentUserSettings.lineHeight !== settings.lineHeight)
    ) {
      userPayload.lineHeight = settings.lineHeight
    }
    if (settings.darkModePdf !== undefined) {
      const val = Boolean(settings.darkModePdf)
      if (!currentUserSettings || currentUserSettings.darkModePdf !== val) {
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
      (!currentProject || currentProject.compiler !== settings.compiler)
    ) {
      projectPayload.compiler = settings.compiler
    }
    if (
      settings.imageName !== undefined &&
      (!currentProject || currentProject.imageName !== settings.imageName)
    ) {
      projectPayload.imageName = settings.imageName
    }
    if (
      settings.rootDocId !== undefined &&
      (!currentProject || currentProject.rootDocId !== settings.rootDocId)
    ) {
      projectPayload.rootDocId = settings.rootDocId
    }
    if (
      settings.rootDocPath !== undefined &&
      (!currentProject || currentProject.rootDocPath !== settings.rootDocPath)
    ) {
      projectPayload.rootDocPath = settings.rootDocPath
    }

    if (Object.keys(projectPayload).length > 0 && projectContext?.updateProject) {
      try {
        projectContext.updateProject(projectPayload)
      } catch {}
    }

    if (typeof localStorage !== 'undefined' || typeof window !== 'undefined') {
      if (settings.draft !== undefined) {
        try {
          const val = JSON.stringify(Boolean(settings.draft))
          if (projectId && typeof localStorage !== 'undefined') {
            localStorage.setItem(`draft:${projectId}`, val)
          }
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new StorageEvent('storage', {
                key: projectId ? `draft:${projectId}` : 'draft',
                newValue: val,
              })
            )
          }
        } catch {}
      }
      if (settings.stopOnFirstError !== undefined) {
        try {
          const val = JSON.stringify(Boolean(settings.stopOnFirstError))
          if (projectId && typeof localStorage !== 'undefined') {
            localStorage.setItem(`stop_on_first_error:${projectId}`, val)
          }
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new StorageEvent('storage', {
                key: projectId ? `stop_on_first_error:${projectId}` : 'stop_on_first_error',
                newValue: val,
              })
            )
          }
        } catch {}
      }
    }
  }

  const isEditor =
    toolName === 'configure_editor_settings' ||
    'mode' in settings ||
    'autoComplete' in settings ||
    'autoPairDelimiters' in settings ||
    'syntaxValidation' in settings ||
    'previewTabs' in settings ||
    'pdfViewer' in settings ||
    'mathPreview' in settings ||
    'breadcrumbs' in settings ||
    'editorTabs' in settings ||
    'spellCheckLanguage' in settings

  if (isEditor) {
    const userPayload: any = {}
    const userKeys = [
      'mode',
      'autoComplete',
      'autoPairDelimiters',
      'syntaxValidation',
      'previewTabs',
      'pdfViewer',
      'mathPreview',
      'breadcrumbs',
      'editorTabs',
      'nonBlinkingCursor',
      'floatingMenu',
      'spellCheckLanguage',
    ]
    for (const k of userKeys) {
      if (
        settings[k] !== undefined &&
        (!currentUserSettings || currentUserSettings[k] !== settings[k])
      ) {
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
