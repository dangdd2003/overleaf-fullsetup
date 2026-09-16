import { useCallback, useContext, useMemo, useRef } from 'react'
import { buildProjectIndex, ProjectIndex } from './context/project-index'
import { Text } from '@codemirror/state'
import { RegExpCursor, SearchCursor } from '@codemirror/search'
import { useProjectContext } from '@/shared/context/project-context'
import { useLocalCompileContext } from '@/shared/context/local-compile-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useFileTreeData } from '@/shared/context/file-tree-data-context'
import { findEntityByPath, pathInFolder } from '@/features/file-tree/util/path'
import { syncCreateEntity } from '@/features/file-tree/util/sync-mutation'
import useEventListener from '@/shared/hooks/use-event-listener'
import { Folder } from '@ol-types/folder'
import { applyLiveSettingsUpdate } from './live-settings-updater'
import { postJSON } from '@/infrastructure/fetch-json'
import { UserSettingsContext } from '@/shared/context/user-settings-context'
import getMeta from '@/utils/meta'
import {
  AppearanceSettings,
  AvailableSettingsOptions,
  CompileOutcome,
  CompilerSettings,
  EditOutcome,
  EditRequest,
  EditorSettings,
  LastCompile,
  LogEntrySummary,
  ProjectFile,
  ProjectHandle,
  ProjectSettingsSummary,
  SearchHit,
} from './project-handle'

const REPLY_TIMEOUT_MS = 5000
const COMPILE_TIMEOUT_MS = 120000
const POLL_INTERVAL_MS = 500

export function findUniqueSpan(text: string, oldText: string) {
  // Append mode: empty oldText matches the very end of the file
  if (!oldText) {
    return { status: 'found' as const, index: text.length }
  }

  // 1. Exact match
  const first = text.indexOf(oldText)
  if (first !== -1) {
    let matches = 0
    let index = first
    while (index !== -1) {
      matches += 1
      index = text.indexOf(oldText, index + oldText.length)
    }
    if (matches > 1) return { status: 'ambiguous' as const, matches }
    return { status: 'found' as const, index: first }
  }

  // 2. Trailing whitespace-normalized match
  const normText = text
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normOld = oldText
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normFirst = normText.indexOf(normOld)
  if (normFirst !== -1) {
    let matches = 0
    let index = normFirst
    while (index !== -1) {
      matches += 1
      index = normText.indexOf(normOld, index + normOld.length)
    }
    if (matches > 1) return { status: 'ambiguous' as const, matches }

    const lineNum = normText.slice(0, normFirst).split('\n').length - 1
    const origLines = text.split('\n')
    let origIndex = 0
    for (let i = 0; i < lineNum; i++) {
      origIndex += origLines[i].length + 1
    }
    const lineOffset =
      normFirst -
      normText.split('\n').slice(0, lineNum).join('\n').length -
      (lineNum > 0 ? 1 : 0)
    origIndex += Math.max(0, lineOffset)
    return { status: 'found' as const, index: origIndex }
  }

  // 3. Line-by-line trimmed match
  const textLines = text.split('\n')
  const oldLines = oldText.split('\n').map(l => l.trim()).filter(Boolean)
  if (oldLines.length > 0) {
    const matchingStarts: number[] = []
    for (let i = 0; i <= textLines.length - oldLines.length; i++) {
      let matches = true
      for (let j = 0; j < oldLines.length; j++) {
        if (textLines[i + j].trim() !== oldLines[j]) {
          matches = false
          break
        }
      }
      if (matches) matchingStarts.push(i)
    }
    if (matchingStarts.length === 1) {
      const lineIdx = matchingStarts[0]
      const charIndex =
        textLines.slice(0, lineIdx).join('\n').length + (lineIdx > 0 ? 1 : 0)
      return { status: 'found' as const, index: charIndex }
    }
    if (matchingStarts.length > 1) {
      return { status: 'ambiguous' as const, matches: matchingStarts.length }
    }
  }

  return { status: 'noMatch' as const }
}

export function spanToLineRange(
  text: string,
  index: number,
  length: number
): { from: number; to: number } {
  const from = text.slice(0, index).split('\n').length
  const to = text.slice(0, index + length).split('\n').length
  return { from, to }
}

export function docToProjectFile(path: string, content: any): ProjectFile {
  if (content === null || content === undefined) {
    return { path, type: 'doc', size: 0, lines: 0 }
  }
  const str = String(content)
  return {
    path,
    type: 'doc',
    size: str.length,
    lines: str === '' ? 1 : str.split('\n').length,
  }
}

export function toLastCompile(entries: any, rawLog?: string | null): LastCompile | null {
  if (!entries) return null
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => ({
    message: e.message ?? '',
    file: e.file ?? null,
    line: e.line ?? null,
  }))
  const warnings: LogEntrySummary[] = (entries.warnings ?? entries.all ?? [])
    .filter((e: any) => e.level === 'warning' || entries.warnings)
    .map((e: any) => ({
      message: e.message ?? '',
      file: e.file ?? null,
      line: e.line ?? null,
    }))
  const status = errors.length > 0 ? 'failure' : 'success'
  return {
    status,
    errors,
    warnings,
    rawLog: rawLog ?? null,
  }
}

export function toCompileOutcome(entries: any): CompileOutcome {
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => ({
    message: e.message ?? '',
    file: e.file ?? null,
    line: e.line ?? null,
  }))
  const warnings: LogEntrySummary[] = (entries.warnings ?? []).map((e: any) => ({
    message: e.message ?? '',
    file: e.file ?? null,
    line: e.line ?? null,
  }))
  return {
    status: errors.length > 0 ? 'failure' : 'success',
    errors,
    warnings,
  }
}

export function folderIdForPath(root: Folder, segments: string[]): string | null {
  if (!root) return null
  if (!segments || segments.length === 0) return root._id
  let current: Folder | null = root
  for (const part of segments) {
    if (!current?.folders) return null
    const next: Folder | undefined = current.folders.find(f => f.name === part)
    if (!next) return null
    current = next
  }
  return current?._id ?? null
}

function normalizeDoc(content: any): string[] {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return content.split('\n')
  if (content && typeof content.toString === 'function') {
    return content.toString().split('\n')
  }
  return []
}

function readDocOverBridge(timeoutMs = REPLY_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      if (timer) clearTimeout(timer)
      resolve((event as CustomEvent)?.detail?.text ?? null)
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      resolve(null)
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentReadDoc'))
  })
}

function applyEditOverBridge(
  detail: { from: number; to: number; oldText: string; replacement: string },
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<{ status: string }> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      if (timer) clearTimeout(timer)
      resolve((event as CustomEvent)?.detail ?? { status: 'drifted' })
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      resolve({ status: 'drifted' })
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
  })
}

const DEFAULT_EDITOR_THEMES: Array<{ name: string; label?: string; dark: boolean }> = [
  { name: 'cobalt', dark: true },
  { name: 'dracula', dark: true },
  { name: 'eclipse', dark: false },
  { name: 'monokai', dark: true },
  { name: 'overleaf', dark: false },
  { name: 'overleaf_dark', dark: true },
  { name: 'textmate', dark: false },
  { name: 'ambiance', dark: true },
  { name: 'chaos', dark: true },
  { name: 'chrome', dark: false },
  { name: 'clouds', dark: false },
  { name: 'clouds_midnight', dark: true },
  { name: 'crimson_editor', dark: false },
  { name: 'dawn', dark: false },
  { name: 'dreamweaver', dark: false },
  { name: 'github', dark: false },
  { name: 'gob', dark: true },
  { name: 'gruvbox', dark: true },
  { name: 'idle_fingers', dark: true },
  { name: 'iplastic', dark: false },
  { name: 'katzenmilch', dark: false },
  { name: 'kr_theme', dark: true },
  { name: 'kuroir', dark: false },
  { name: 'merbivore', dark: true },
  { name: 'merbivore_soft', dark: true },
  { name: 'mono_industrial', dark: true },
  { name: 'nord_dark', dark: true },
  { name: 'pastel_on_dark', dark: true },
  { name: 'solarized_dark', dark: true },
  { name: 'solarized_light', dark: false },
  { name: 'sqlserver', dark: false },
  { name: 'terminal', dark: true },
  { name: 'tomorrow', dark: false },
  { name: 'tomorrow_night', dark: true },
  { name: 'tomorrow_night_blue', dark: true },
  { name: 'tomorrow_night_bright', dark: true },
  { name: 'tomorrow_night_eighties', dark: true },
  { name: 'twilight', dark: true },
  { name: 'vibrant_ink', dark: true },
  { name: 'xcode', dark: false },
]

export function useProjectHandle({
  requestApproval,
}: {
  requestApproval: (
    edit: EditRequest,
    context: { startLine: number }
  ) => Promise<{ accepted: boolean; note?: string }>
}): ProjectHandle {
  const { projectSnapshot, project, updateProject } = useProjectContext()
  const { startCompile, logEntries, rawLog } = useLocalCompileContext()
  const { openDocWithId, getCurrentDocumentId } = useEditorManagerContext()
  const { fileTreeData } = useFileTreeData()
  const userSettingsContext = useContext(UserSettingsContext)

  const logEntriesRef = useRef(logEntries)
  logEntriesRef.current = logEntries
  const rawLogRef = useRef(rawLog)
  rawLogRef.current = rawLog
  const indexRef = useRef<ProjectIndex | null>(null)

  const selectionRef = useRef<{
    path: string
    from: number
    to: number
    text: string
  } | null>(null)

  useEventListener('aiAssist:agentSelection', (event: Event) => {
    selectionRef.current = (event as CustomEvent).detail ?? null
  })

  useEventListener('aiAssist:selectionChanged', (event: Event) => {
    selectionRef.current = (event as CustomEvent).detail ?? null
  })

  const cursorLineRef = useRef<number | null>(null)

  useEventListener('aiAssist:agentCursor', (event: Event) => {
    const detail = (event as CustomEvent<{ line: number } | null>).detail
    cursorLineRef.current = detail?.line ?? null
  })

  const rootDocPath = useCallback((): string | null => {
    if (!project?.rootDocId || !fileTreeData) return null
    return pathInFolder(fileTreeData, project.rootDocId)
  }, [project?.rootDocId, fileTreeData])

  const listFiles = useCallback(async (): Promise<ProjectFile[]> => {
    const docs = (projectSnapshot as any)?.docs ?? {}
    const files = (projectSnapshot as any)?.files ?? {}
    const result: ProjectFile[] = []

    if (projectSnapshot?.getDocPaths) {
      const paths = projectSnapshot.getDocPaths()
      for (const p of paths) {
        const norm = p.replace(/^\//, '')
        const docContents =
          projectSnapshot.getDocContents?.(norm) ??
          projectSnapshot.getDocContents?.('/' + norm) ??
          ''
        const lines = typeof docContents === 'string' ? docContents.split('\n') : []
        result.push({
          path: norm,
          type: 'doc',
          size: lines.reduce((sum, l) => sum + l.length + 1, 0),
          lines: lines.length,
        })
      }
    } else {
      for (const [path, doc] of Object.entries(docs)) {
        const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
        result.push({
          path: path.replace(/^\//, ''),
          type: 'doc',
          size: lines.reduce((sum, l) => sum + l.length + 1, 0),
          lines: lines.length,
        })
      }
    }

    if (projectSnapshot?.getBinaryFilePathsWithHash) {
      const binaries = projectSnapshot.getBinaryFilePathsWithHash()
      for (const b of binaries) {
        result.push({
          path: (b.path || '').replace(/^\//, ''),
          type: 'binary',
          size: 0,
        })
      }
    } else {
      for (const [path, file] of Object.entries(files)) {
        result.push({
          path: path.replace(/^\//, ''),
          type: 'binary',
          size: (file as any)?.file?.size ?? 0,
        })
      }
    }

    return result
  }, [projectSnapshot])

  const readFile = useCallback(
    async (
      path: string,
      range?: { from: number; to: number }
    ): Promise<{ lines: string[]; truncated: boolean }> => {
      const norm = path.replace(/^\//, '')
      let allLines: string[] | null = null
      const docContents = projectSnapshot?.getDocContents?.(norm) ?? projectSnapshot?.getDocContents?.('/' + norm)
      if (typeof docContents === 'string') {
        allLines = docContents.split('\n')
      } else {
        const docs = (projectSnapshot as any)?.docs ?? {}
        const doc = docs[norm] ?? docs['/' + norm]
        if (!doc) {
          throw new Error(`File not found: ${path}`)
        }
        allLines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
      }
      const from = range ? Math.max(1, range.from) : 1
      const to = range ? Math.min(allLines.length, range.to) : allLines.length
      const lines = allLines.slice(from - 1, to)
      return {
        lines,
        truncated: lines.length < allLines.length,
      }
    },
    [projectSnapshot]
  )

  const search = useCallback(
    async (
      query: string,
      options: { caseSensitive?: boolean; regexp?: boolean } = {}
    ): Promise<SearchHit[]> => {
      const docs = (projectSnapshot as any)?.docs ?? {}
      const hits: SearchHit[] = []

      for (const [path, doc] of Object.entries(docs)) {
        const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
        const text = Text.of(lines)

        if (options.regexp) {
          try {
            const cursor = new RegExpCursor(
              text,
              query,
              { ignoreCase: !options.caseSensitive },
              0,
              text.length
            )
            while (!cursor.next().done && hits.length < 50) {
              const line = text.lineAt(cursor.value.from)
              hits.push({
                path: path.replace(/^\//, ''),
                line: line.number,
                text: line.text,
              })
            }
          } catch {
            // fall back to string search on bad regex
          }
        } else {
          const cursor = new SearchCursor(
            text,
            query,
            0,
            text.length,
            options.caseSensitive ? s => s : s => s.toLowerCase()
          )
          while (!cursor.next().done && hits.length < 50) {
            const line = text.lineAt(cursor.value.from)
            hits.push({
              path: path.replace(/^\//, ''),
              line: line.number,
              text: line.text,
            })
          }
        }
      }

      return hits
    },
    [projectSnapshot]
  )

  const currentSelection = useCallback(() => {
    return selectionRef.current
  }, [])

  const proposeEdit = useCallback(
    async (edit: EditRequest): Promise<EditOutcome> => {
      const bridgeText = await readDocOverBridge()
      let content = bridgeText
      if (content === null) {
        const norm = edit.path.replace(/^\//, '')
        const docContents = projectSnapshot?.getDocContents?.(norm) ?? projectSnapshot?.getDocContents?.('/' + norm)
        if (typeof docContents === 'string') {
          content = docContents
        } else {
          const docs = (projectSnapshot as any)?.docs ?? {}
          const doc = docs[norm] ?? docs['/' + norm]
          if (!doc) return { status: 'noMatch' }
          const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
          content = lines.join('\n')
        }
      }

      const span = findUniqueSpan(content, edit.oldText)
      if (span.status !== 'found') {
        return span
      }

      const { from: startLine } = spanToLineRange(content, span.index, edit.oldText.length)

      const approval = await requestApproval(edit, { startLine })
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      if (fileTreeData && openDocWithId) {
        const entity = findEntityByPath(fileTreeData, edit.path)
        if (entity?.type === 'doc') {
          openDocWithId(entity.entity._id)
        }
      }

      const { to: endLine } = spanToLineRange(content, span.index + edit.oldText.length, 0)
      const applied = await applyEditOverBridge({
        from: startLine,
        to: endLine,
        oldText: edit.oldText,
        replacement: edit.newText,
      })

      return applied?.status === 'applied'
        ? { status: 'applied', startLine }
        : { status: 'drifted' }
    },
    [projectSnapshot, fileTreeData, openDocWithId, requestApproval]
  )

  const compile = useCallback(async (): Promise<CompileOutcome> => {
    if (!startCompile) {
      throw new Error('Compilation is not available in this context.')
    }

    startCompile()

    const start = Date.now()
    while (Date.now() - start < COMPILE_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      const current = logEntriesRef.current
      if (current && (current.errors?.length > 0 || current.all?.length > 0)) {
        return toCompileOutcome(current)
      }
    }

    throw new Error('Compile timed out waiting for results.')
  }, [startCompile])

  const openFile = useCallback((): { path: string; cursorLine: number | null } | null => {
    if (!getCurrentDocumentId || !fileTreeData) return null
    const docId = getCurrentDocumentId()
    if (!docId) return null
    const path = pathInFolder(fileTreeData, docId)
    if (!path) return null
    return { path, cursorLine: cursorLineRef.current }
  }, [getCurrentDocumentId, fileTreeData])

  const lastCompile = useCallback((): LastCompile | null => {
    return toLastCompile(logEntriesRef.current, rawLogRef.current)
  }, [])

  const index = useCallback(async (): Promise<ProjectIndex> => {
    const docs = (projectSnapshot as any)?.docs ?? {}
    const stringDocs: Record<string, string> = {}
    for (const [path, doc] of Object.entries(docs)) {
      const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
      stringDocs[path.replace(/^\//, '')] = lines.join('\n')
    }
    indexRef.current = buildProjectIndex(
      { docs: stringDocs, rootPath: rootDocPath() },
      indexRef.current
    )
    return indexRef.current
  }, [projectSnapshot, rootDocPath])

  const createFile = useCallback(
    async (request: { path: string; content: string }): Promise<EditOutcome> => {
      const approval = await requestApproval(
        { path: request.path, oldText: '', newText: request.content },
        { startLine: 1 }
      )
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      const norm = request.path.replace(/^\//, '')
      if (fileTreeData && project?._id) {
        const segments = norm.split('/')
        segments.pop() // remove file name
        const folderId = folderIdForPath(fileTreeData, segments) ?? fileTreeData._id
        const fileName = norm.split('/').pop()!
        try {
          syncCreateEntity(project._id, folderId, {
            endpoint: 'doc',
            name: fileName,
          })
        } catch {
          // ignore if cannot sync
        }
      }

      const applied = await applyEditOverBridge({
        from: 1,
        to: 1,
        oldText: '',
        replacement: request.content,
      })

      return applied?.status === 'applied'
        ? { status: 'applied', startLine: 1 }
        : { status: 'drifted' }
    },
    [fileTreeData, project?._id, requestApproval]
  )

  const getProjectSettings = useCallback(async (): Promise<ProjectSettingsSummary> => {
    const s: any = userSettingsContext?.userSettings || getMeta('ol-userSettings') || {}
    const appearance: AppearanceSettings = {
      overallTheme: s.overallTheme || 'system',
      editorTheme: s.editorTheme || 'textmate',
      editorLightTheme: s.editorLightTheme || 'textmate',
      editorDarkTheme: s.editorDarkTheme || 'overleaf_dark',
      darkModePdf: s.darkModePdf ?? false,
      fontSize: s.fontSize ?? 12,
      fontFamily: s.fontFamily ?? null,
      lineHeight: s.lineHeight ?? null,
    }
    const compiler: CompilerSettings = {
      compiler: project?.compiler ?? 'pdflatex',
      imageName: project?.imageName ?? null,
      rootDocPath: rootDocPath(),
      rootDocId: project?.rootDocId ?? null,
      draft: (project as any)?.draft ?? false,
      stopOnFirstError: (project as any)?.stopOnFirstError ?? false,
    }
    const editor: EditorSettings = {
      mode: s.mode || 'none',
      autoComplete: s.autoComplete ?? true,
      autoPairDelimiters: s.autoPairDelimiters ?? true,
      syntaxValidation: s.syntaxValidation ?? true,
      pdfViewer: s.pdfViewer || 'pdfjs',
      mathPreview: s.mathPreview ?? true,
      breadcrumbs: s.breadcrumbs ?? true,
      editorTabs: s.editorTabs ?? true,
      spellCheckLanguage: s.spellCheckLanguage || 'en',
    }
    const spelling = {
      spellCheckLanguage: project?.spellCheckLanguage ?? null,
    }
    return {
      compiler,
      appearance,
      editor,
      spelling,
      name: project?.name ?? '',
      description: (project as any)?.description ?? '',
    }
  }, [project, rootDocPath, userSettingsContext])

  const configureAppearanceSettings = useCallback(
    async (settingsToUpdate: Partial<AppearanceSettings>) => {
      const payload: any = {}
      const allowed: Array<keyof AppearanceSettings> = [
        'overallTheme',
        'editorTheme',
        'editorLightTheme',
        'editorDarkTheme',
        'darkModePdf',
        'fontSize',
        'fontFamily',
        'lineHeight',
      ]
      for (const key of allowed) {
        if (settingsToUpdate[key] !== undefined) {
          payload[key] = settingsToUpdate[key]
        }
      }

      if (Object.keys(payload).length === 0) {
        throw new Error('No valid appearance settings provided to update.')
      }

      try {
        await postJSON('/user/settings', { body: payload })
        applyLiveSettingsUpdate('configure_appearance_settings', payload, {
          userSettingsContext,
          projectContext: { updateProject },
          projectId: project?._id,
        })
      } catch (err: any) {
        throw new Error(err?.message || 'Failed to update appearance settings.')
      }

      return {
        status: 'applied' as const,
        updatedSettings: payload,
        message: 'Appearance settings updated successfully.',
      }
    },
    [userSettingsContext, project?._id, updateProject]
  )

  const configureCompilerSettings = useCallback(
    async (settingsToUpdate: Partial<CompilerSettings>) => {
      let rootDocId = settingsToUpdate.rootDocId
      if (!rootDocId && settingsToUpdate.rootDocPath && fileTreeData) {
        const entity = findEntityByPath(fileTreeData, settingsToUpdate.rootDocPath)
        if (entity?.type === 'doc') {
          rootDocId = entity.entity._id
        }
      }

      const payload: any = {}
      if (settingsToUpdate.compiler !== undefined) payload.compiler = settingsToUpdate.compiler
      if (settingsToUpdate.imageName !== undefined) payload.imageName = settingsToUpdate.imageName
      if (rootDocId !== undefined) payload.rootDocId = rootDocId
      if (settingsToUpdate.draft !== undefined) payload.draft = settingsToUpdate.draft
      if (settingsToUpdate.stopOnFirstError !== undefined) payload.stopOnFirstError = settingsToUpdate.stopOnFirstError

      if (Object.keys(payload).length === 0 && !settingsToUpdate.rootDocPath) {
        throw new Error('No valid compiler settings provided to update.')
      }

      const projectId = project?._id
      if (projectId) {
        try {
          await postJSON(`/project/${projectId}/settings`, { body: payload })
          applyLiveSettingsUpdate('configure_compiler_settings', settingsToUpdate, {
            userSettingsContext,
            projectContext: { updateProject },
            projectId,
          })
        } catch (err: any) {
          throw new Error(err?.message || 'Failed to update compiler settings.')
        }
      }

      return {
        status: 'applied' as const,
        updatedSettings: settingsToUpdate,
        message: 'Compiler settings updated successfully.',
      }
    },
    [project?._id, updateProject, fileTreeData, userSettingsContext]
  )

  const configureEditorSettings = useCallback(
    async (settingsToUpdate: Partial<EditorSettings>) => {
      const payload: any = {}
      const allowed: Array<keyof EditorSettings> = [
        'mode',
        'autoComplete',
        'autoPairDelimiters',
        'syntaxValidation',
        'pdfViewer',
        'mathPreview',
        'breadcrumbs',
        'editorTabs',
        'spellCheckLanguage',
      ]
      for (const key of allowed) {
        if (settingsToUpdate[key] !== undefined) {
          payload[key] = settingsToUpdate[key]
        }
      }

      if (Object.keys(payload).length === 0) {
        throw new Error('No valid editor settings provided to update.')
      }

      try {
        await postJSON('/user/settings', { body: payload })
        applyLiveSettingsUpdate('configure_editor_settings', payload, {
          userSettingsContext,
          projectContext: { updateProject },
          projectId: project?._id,
        })
      } catch (err: any) {
        throw new Error(err?.message || 'Failed to update editor settings.')
      }

      return {
        status: 'applied' as const,
        updatedSettings: payload,
        message: 'Editor settings updated successfully.',
      }
    },
    [userSettingsContext, project?._id, updateProject]
  )

  const listAvailableSettings = useCallback(async (): Promise<AvailableSettingsOptions> => {
    const languages = (getMeta('ol-languages') || []).map((l: any) => ({
      code: l.code,
      name: l.name,
    }))
    const rawImages: any[] =
      (getMeta('ol-imageNames') as any[]) ||
      ((getMeta as any)('ol-allowedImageNames') as any[]) ||
      []
    const imageNames = rawImages.map((img: any) => ({
      imageName: img.imageName,
      imageDesc: img.imageDesc || img.imageName,
      default: Boolean(img.default),
    }))
    const metaModernThemes: Array<{ name: string; label?: string; dark: boolean }> =
      getMeta('ol-editorThemes') || []
    const metaLegacyThemes: Array<{ name: string; label?: string; dark: boolean }> =
      getMeta('ol-legacyEditorThemes') || []
    const combinedThemes = [...metaModernThemes, ...metaLegacyThemes]
    const editorThemes =
      combinedThemes.length > 0
        ? combinedThemes.map(t => ({
            name: t.name,
            label: t.label,
            dark: Boolean(t.dark),
          }))
        : DEFAULT_EDITOR_THEMES

    const fontFamilies = [
      { name: 'monaco', label: 'Monaco / Menlo / Consolas' },
      { name: 'lucida', label: 'Lucida / Source Code Pro' },
      { name: 'opendyslexicmono', label: 'OpenDyslexic Mono' },
    ]

    return {
      compilers: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
      imageNames:
        imageNames.length > 0
          ? imageNames
          : [{ imageName: 'texlive-2024.1', imageDesc: 'TeX Live 2024', default: true }],
      spellCheckLanguages:
        languages.length > 0
          ? languages
          : [
              { code: 'en', name: 'English' },
              { code: 'en_GB', name: 'English (British)' },
              { code: 'en_US', name: 'English (American)' },
              { code: 'fr', name: 'French' },
              { code: 'de', name: 'German' },
              { code: 'es', name: 'Spanish' },
            ],
      editorModes: ['none', 'vim', 'emacs'],
      overallThemes: ['system', 'light', 'dark'],
      editorThemes,
      fontFamilies,
      lineHeights: ['compact', 'normal', 'spacious'],
      fontSizes: [10, 11, 12, 13, 14, 16, 18, 20, 24],
      pdfViewers: ['pdfjs', 'native'],
    }
  }, [])

  return useMemo(
    () => ({
      rootDocPath,
      listFiles,
      readFile,
      search,
      currentSelection,
      proposeEdit,
      compile,
      openFile,
      lastCompile,
      index,
      createFile,
      getProjectSettings,
      configureAppearanceSettings,
      configureCompilerSettings,
      configureEditorSettings,
      listAvailableSettings,
    }),
    [
      rootDocPath,
      listFiles,
      readFile,
      search,
      currentSelection,
      proposeEdit,
      compile,
      openFile,
      lastCompile,
      index,
      createFile,
      getProjectSettings,
      configureAppearanceSettings,
      configureCompilerSettings,
      configureEditorSettings,
      listAvailableSettings,
    ]
  )
}
