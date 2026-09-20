import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
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
import { errorExcerpt, excerptAround } from './tools/compile-result'
import { matchesGlob } from './tools/search-text'
import { applyLiveSettingsUpdate } from './live-settings-updater'
import { locateAnchorInText, countOccurrences } from './latex-matcher'
import {
  createSnapshotGate,
  filesFromFileTree,
  SnapshotUnavailableError,
} from './snapshot-gate'
import { postJSON } from '@/infrastructure/fetch-json'
import { UserSettingsContext } from '@/shared/context/user-settings-context'
import getMeta from '@/utils/meta'
import {
  AppearanceSettings,
  AvailableSettingsOptions,
  CompileOptions,
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
/**
 * How long to wait for an editor compile that was already running to finish —
 * an auto-compile after an accepted edit, or the user's own. As long as a
 * compile may take, so the tool waits it out instead of skipping.
 */
const COMPILE_IDLE_TIMEOUT_MS = COMPILE_TIMEOUT_MS
/**
 * How long to wait for the log to be fetched and parsed after the compile
 * response lands. `handleLogFiles` downloads output.log (and every .blg) over
 * the network, so this is a separate budget from the compile itself.
 */
const LOG_SETTLE_TIMEOUT_MS = 30000

/**
 * A compile that produced a response but no parsable output.
 *
 * Distinct from a failure: nothing in the log said the document is wrong, the
 * build just yielded nothing the editor could read. A clean rebuild is the
 * usual remedy, so the tool says so rather than reporting a false success.
 */
export const COMPILE_NO_OUTPUT = 'no-output'
/** A compile that never started because one was already running. */
export const COMPILE_SKIPPED = 'skipped'

/**
 * Waits for the editor's compile state to satisfy `settled`.
 *
 * Returns true when it did, false when the budget ran out. The signal is
 * checked before every sleep so an aborted run stops on the next tick instead
 * of after the remaining timeout.
 */
export async function waitFor(
  settled: () => boolean,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < options.timeoutMs) {
    if (options.signal?.aborted) throw new Error('Compile cancelled')
    if (settled()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return settled()
}

export type UniqueSpanResult =
  | { status: 'found'; index: number; matchedLength: number }
  | { status: 'ambiguous'; matches: number }
  | { status: 'noMatch' }

export function findUniqueSpan(text: string, oldText: string): UniqueSpanResult {
  // Append mode: empty oldText matches the very end of the file
  if (!oldText) {
    return { status: 'found', index: text.length, matchedLength: 0 }
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
    if (matches > 1) return { status: 'ambiguous', matches }
    return { status: 'found', index: first, matchedLength: oldText.length }
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
    if (matches > 1) return { status: 'ambiguous', matches }

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

    const oldLines = oldText.split('\n')
    const oldLineCount = oldLines.length
    let matchedLength: number
    if (oldLineCount === 1) {
      matchedLength = Math.min(
        oldText.length,
        origLines[lineNum].length - lineOffset
      )
    } else {
      let len = origLines[lineNum].length - lineOffset + 1
      for (let i = 1; i < oldLineCount - 1; i++) {
        len += origLines[lineNum + i].length + 1
      }
      len += Math.min(
        origLines[lineNum + oldLineCount - 1].length,
        oldLines[oldLineCount - 1].length
      )
      matchedLength = len
    }

    return {
      status: 'found',
      index: origIndex,
      matchedLength: Math.max(0, matchedLength),
    }
  }

  // 3. Line-by-line trimmed match (preserving blank lines for 1:1 alignment)
  const textLines = text.split('\n')
  const oldLines = oldText.split('\n').map(l => l.trim())
  if (oldLines.length > 0 && oldLines.some(l => l.length > 0)) {
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
      let charIndex = 0
      for (let i = 0; i < lineIdx; i++) {
        charIndex += textLines[i].length + 1
      }
      const matchedLines = textLines.slice(lineIdx, lineIdx + oldLines.length)
      const matchedLength = matchedLines.join('\n').length
      return { status: 'found', index: charIndex, matchedLength }
    }
    if (matchingStarts.length > 1) {
      return { status: 'ambiguous', matches: matchingStarts.length }
    }
  }

  // 4. Token & fuzzy match via locateAnchorInText
  const match = locateAnchorInText(text, oldText)
  if (match) {
    if (typeof match.charStart === 'number' && typeof match.charEnd === 'number') {
      return {
        status: 'found',
        index: match.charStart,
        matchedLength: match.charEnd - match.charStart,
      }
    }
    const idx = text.indexOf(match.anchor)
    if (idx !== -1) {
      const occurrences = countOccurrences(text, match.anchor)
      if (occurrences === 1) {
        return { status: 'found', index: idx, matchedLength: match.anchor.length }
      }
      if (occurrences > 1) {
        return { status: 'ambiguous', matches: occurrences }
      }
    }
  }

  return { status: 'noMatch' }
}

export function spanToLineRange(
  text: string,
  index: number,
  length: number
): { from: number; to: number } {
  const from = text.slice(0, index).split('\n').length
  const effectiveEnd =
    length > 0 && text[index + length - 1] === '\n'
      ? index + length - 1
      : index + length
  const to = text.slice(0, effectiveEnd).split('\n').length
  return { from, to: Math.max(from, to) }
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
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => {
    const summary: LogEntrySummary = {
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }
    const excerpt = errorExcerpt(e)
    if (excerpt) summary.excerpt = excerpt
    return summary
  })
  const warnings: LogEntrySummary[] = (entries.warnings ?? entries.all ?? [])
    .filter((e: any) => e.level === 'warning' || entries.warnings)
    .map((e: any) => ({
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }))
  const status = errors.length > 0 ? 'failure' : 'success'
  return {
    status,
    errors,
    warnings,
    rawLog: rawLog ?? null,
  }
}

/**
 * What the editor was observed to do during a compile.
 *
 * A discriminated union because the two cases have genuinely different
 * evidence: a build that never produced a response has no log to read, while
 * one that did may still have failed to yield a parsable one.
 */
export type CompileObservation =
  | {
      /** The compile request never produced a response. */
      kind: 'no-response'
      /** True when the wait for any sign of life ran out. */
      timedOut: boolean
      /** The editor's own error, when it recorded one. */
      error?: string
    }
  | {
      kind: 'responded'
      /** True when the log arrived and replaced the previous compile's. */
      settled: boolean
      /** The parsed log entries, if they settled. */
      entries?: any
      error?: string
    }

/**
 * Turns an observation into the outcome the model is told about.
 *
 * Pure and exported so the verdict can be tested without React, a compile
 * context, or a network: the hook does the waiting, this decides what the
 * waiting means.
 *
 * The rule throughout is that an unexplained build is never reported as a clean
 * one. Folding `no-output` or `timedout` into "0 errors" is what lets a model
 * tell the user its fix worked when no build ever finished.
 */
export function resolveCompileOutcome(
  observation: CompileObservation,
  rawLog?: string | null
): CompileOutcome {
  // 'clear-cache' is what the editor records when a cache clear failed. It is
  // not a compile status, so it never stands in for one; if it is still set
  // when the compile was meant to report, the compile reported nothing.
  const error = observation.error
  const failure = error && error !== 'clear-cache' ? error : undefined

  if (observation.kind === 'no-response') {
    if (observation.timedOut) return toCompileOutcome(null, 'timedout')
    // CLSI unreachable, rate limited, a 429 on the POST: the editor's error
    // already names it, and nothing else is coming.
    return toCompileOutcome(null, failure ?? 'failure')
  }

  if (!observation.settled) {
    return toCompileOutcome(null, failure ?? COMPILE_NO_OUTPUT)
  }

  return toCompileOutcome(observation.entries, rawLog, failure)
}

/**
 * Summarises parsed log entries into a compile outcome.
 *
 * `status` overrides the derived one. Log entries cannot describe a build that
 * never produced a log — `timedout`, `clsi-unavailable`, `rate-limited` and the
 * rest arrive as an editor error with no entries at all — and reporting those
 * as "success, 0 errors" would have the model tell the user its edit fixed
 * something that never compiled.
 */
export function toCompileOutcome(
  entries: any,
  rawLogOrStatus?: string | null,
  statusOverride?: string
): CompileOutcome {
  let status: string | undefined = statusOverride
  let rawLog: string | null | undefined = undefined

  if (typeof rawLogOrStatus === 'string') {
    if (
      rawLogOrStatus.includes('\n') ||
      rawLogOrStatus.startsWith('This is') ||
      rawLogOrStatus.includes('!') ||
      rawLogOrStatus.includes('Output written on') ||
      rawLogOrStatus.includes('\\')
    ) {
      rawLog = rawLogOrStatus
    } else if (!entries) {
      status = rawLogOrStatus
    } else {
      if (['success', 'failure', 'timedout', 'no-output', 'skipped'].includes(rawLogOrStatus)) {
        status = rawLogOrStatus
      } else {
        rawLog = rawLogOrStatus
      }
    }
  }

  const errors: LogEntrySummary[] = (entries?.errors ?? []).map((e: any) => {
    const summary: LogEntrySummary = {
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }
    const excerpt =
      errorExcerpt(e) ??
      (rawLog && summary.message ? excerptAround(rawLog, summary.message, 3) : null)
    if (excerpt) {
      summary.excerpt = excerpt
    }
    return summary
  })

  const warnings: LogEntrySummary[] = (entries?.warnings ?? entries?.all ?? [])
    .filter((e: any) => e.level === 'warning' || entries?.warnings)
    .map((e: any) => ({
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }))

  return {
    status: status ?? (errors.length > 0 ? 'failure' : 'success'),
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

export async function ensureFolderPath(
  projectId: string,
  rootFolder: Folder,
  segments: string[]
): Promise<string> {
  if (!segments || segments.length === 0) return rootFolder._id
  let currentFolder = rootFolder
  for (const segment of segments) {
    if (!segment) continue
    const existing: Folder | undefined = currentFolder.folders?.find(f => f.name === segment)
    if (existing) {
      currentFolder = existing
    } else {
      const created = (await syncCreateEntity(projectId, currentFolder._id, {
        endpoint: 'folder',
        name: segment,
      })) as Folder | undefined

      if (!created || !created._id) {
        throw new Error(`Failed to create intermediate folder "${segment}".`)
      }
      const newFolder: Folder = {
        _id: created._id,
        name: segment,
        folders: created.folders ?? [],
        docs: created.docs ?? [],
        fileRefs: created.fileRefs ?? [],
      }
      if (!currentFolder.folders) {
        currentFolder.folders = []
      }
      currentFolder.folders.push(newFolder)
      currentFolder = newFolder
    }
  }
  return currentFolder._id
}

function normalizeDoc(content: any): string[] {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return content.split('\n')
  if (content && typeof content.toString === 'function') {
    return content.toString().split('\n')
  }
  return []
}

/**
 * Every editable document in the project, as `{path: content}`.
 *
 * `ProjectSnapshot` exposes no `docs` property — its API is `getDocPaths()`
 * plus `getDocContents()`. Reading `snapshot.docs` therefore always yields
 * `undefined`, and a caller that iterated it silently saw an empty project.
 */
function snapshotDocs(projectSnapshot: any): Record<string, string> {
  const result: Record<string, string> = {}

  if (projectSnapshot?.getDocPaths) {
    for (const p of projectSnapshot.getDocPaths()) {
      const norm = p.replace(/^\//, '')
      const contents =
        projectSnapshot.getDocContents?.(norm) ??
        projectSnapshot.getDocContents?.('/' + norm)
      if (typeof contents === 'string') {
        result[norm] = contents
      }
    }
    return result
  }

  const docs = projectSnapshot?.docs ?? {}
  for (const [path, doc] of Object.entries(docs)) {
    result[path.replace(/^\//, '')] = normalizeDoc(
      (doc as any)?.doc?.lines ?? doc
    ).join('\n')
  }
  return result
}

export { filesFromFileTree }

export function readDocOverBridge(
  targetPath?: string,
  docId?: string,
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<string | null> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      if (timer) clearTimeout(timer)
      const detail = (event as CustomEvent)?.detail
      if (detail?.text === null || detail?.error === 'pathMismatch' || detail?.error === 'docIdMismatch') {
        resolve(null)
      } else {
        resolve(detail?.text ?? null)
      }
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      resolve(null)
    }, timeoutMs)
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentReadDoc', {
        detail: { path: targetPath, docId },
      })
    )
  })
}

export type BridgeEditDetail = {
  path?: string
  docId?: string
  from?: number
  to?: number
  fromOffset?: number
  toOffset?: number
  oldText: string
  replacement: string
  isAppend?: boolean
}

export function applyEditOverBridge(
  detail: BridgeEditDetail,
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<{
  status: 'applied' | 'drifted' | 'pathMismatch' | 'docIdMismatch' | 'timeout' | 'error'
  message?: string
}> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      if (timer) clearTimeout(timer)
      const result = (event as CustomEvent)?.detail
      if (result && typeof result.status === 'string') {
        resolve(result)
      } else {
        resolve({
          status: 'error',
          message: 'Malformed response from editor bridge.',
        })
      }
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      resolve({
        status: 'timeout',
        message: 'Editor bridge timed out waiting for editor response.',
      })
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
  const {
    startCompile,
    clearCache,
    stopCompile,
    compiling,
    lastCompileOptions,
    error: compileError,
    logEntries,
    rawLog,
  } = useLocalCompileContext()
  const { openDoc, openDocWithId, getCurrentDocumentId } = useEditorManagerContext()
  const { fileTreeData } = useFileTreeData()
  const userSettingsContext = useContext(UserSettingsContext)

  const logEntriesRef = useRef(logEntries)
  logEntriesRef.current = logEntries
  const rawLogRef = useRef(rawLog)
  rawLogRef.current = rawLog
  const indexRef = useRef<ProjectIndex | null>(null)

  // `lastCompileOptions` is memoised on the compile response, so a new identity
  // means exactly one thing: a response landed. It is the only signal in the
  // editor that distinguishes "the compile I started" from "the one that was
  // already on screen", which is what makes the wait below deterministic.
  const lastCompileOptionsRef = useRef(lastCompileOptions)
  lastCompileOptionsRef.current = lastCompileOptions
  const compilingRef = useRef(compiling)
  compilingRef.current = compiling
  const compileErrorRef = useRef(compileError)
  compileErrorRef.current = compileError

  // Counted in an effect rather than observed by the poll, because a build can
  // start and finish between two polls. Reading `compiling` from a ref would
  // miss it entirely, and a repeat failure sets the same error string twice —
  // so with nothing else to notice, the wait would run out its full budget and
  // report a timeout for a build that had already failed.
  const compileFinishedRef = useRef(0)
  const wasCompilingRef = useRef(compiling)
  useEffect(() => {
    if (wasCompilingRef.current && !compiling) compileFinishedRef.current += 1
    wasCompilingRef.current = compiling
  }, [compiling])

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

  const openFile = useCallback((): { path: string; cursorLine: number | null } | null => {
    if (!getCurrentDocumentId || !fileTreeData) return null
    const docId = getCurrentDocumentId()
    if (!docId) return null
    const path = pathInFolder(fileTreeData, docId)
    if (!path) return null
    return { path, cursorLine: cursorLineRef.current }
  }, [getCurrentDocumentId, fileTreeData])

  /**
   * Guarantees the snapshot holds the project before it is read.
   *
   * The snapshot is empty until refreshed at least once, and its instance is
   * created once per project and never replaced — so without this the first
   * read returns nothing and nothing ever invalidates that result. Every read
   * path goes through here, because a reader that skipped it saw whatever the
   * last caller happened to leave behind.
   */
  const snapshotGate = useMemo(
    () => createSnapshotGate(projectSnapshot?.refresh?.bind(projectSnapshot)),
    [projectSnapshot]
  )
  const ensureSnapshot = useCallback(
    () => snapshotGate.ensure(),
    [snapshotGate]
  )
  const invalidateSnapshot = useCallback(
    () => snapshotGate.invalidate(),
    [snapshotGate]
  )

  const listFiles = useCallback(async (): Promise<ProjectFile[]> => {
    let snapshotFailed = false
    try {
      await ensureSnapshot()
    } catch {
      snapshotFailed = true
    }

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

    if (result.length > 0) {
      return result
    }

    // Fallback: when projectSnapshot fails or returns 0 files, derive list from fileTreeData
    if (fileTreeData) {
      const fallbackFiles = filesFromFileTree(fileTreeData)
      if (fallbackFiles.length > 0) {
        const open = openFile()
        if (open?.path) {
          const match = fallbackFiles.find(f => f.path === open.path)
          if (match && match.type === 'doc') {
            const live = await readDocOverBridge(open.path)
            if (typeof live === 'string') {
              match.lines = live.split('\n').length
              match.size = live.length
            }
          }
        }
        return fallbackFiles
      }
    }

    if (snapshotFailed) {
      throw new SnapshotUnavailableError('Project files could not be loaded from server')
    }

    return result
  }, [projectSnapshot, ensureSnapshot, fileTreeData, openFile])

  const readFile = useCallback(
    async (
      path: string,
      range?: { from: number; to: number }
    ): Promise<{ lines: string[]; truncated: boolean }> => {
      const norm = path.replace(/^\//, '')
      let allLines: string[] | null = null

      // Fast path: if the document is currently active in CodeMirror, read live content directly
      const open = openFile()
      const isTargetOpen = Boolean(open?.path && open.path.replace(/^\//, '') === norm)
      if (isTargetOpen) {
        const live = await readDocOverBridge(norm)
        if (typeof live === 'string') {
          allLines = live.split('\n')
        }
      }

      // Snapshot read if not resolved from editor bridge
      if (allLines === null) {
        try {
          await ensureSnapshot()
        } catch {
          // Ignore snapshot failure; continue to fallbacks
        }
        const docContents = projectSnapshot?.getDocContents?.(norm) ?? projectSnapshot?.getDocContents?.('/' + norm)
        if (typeof docContents === 'string') {
          allLines = docContents.split('\n')
        } else {
          const docs = snapshotDocs(projectSnapshot)
          const content = docs[norm] ?? docs['/' + norm]
          if (typeof content === 'string') {
            allLines = content.split('\n')
          }
        }
      }

      // Bridge fallback with docId from fileTreeData
      if (allLines === null && fileTreeData) {
        const entity = findEntityByPath(fileTreeData, norm)
        if (entity?.type === 'doc' && entity.entity?._id) {
          const live = await readDocOverBridge(norm, entity.entity._id)
          if (typeof live === 'string') {
            allLines = live.split('\n')
          }
        }
      }

      if (allLines === null) {
        throw new Error(`File not found: ${path}`)
      }

      const from = range ? Math.max(1, range.from) : 1
      const to = range ? Math.min(allLines.length, range.to) : allLines.length
      const lines = allLines.slice(from - 1, to)
      return {
        lines,
        truncated: lines.length < allLines.length,
      }
    },
    [projectSnapshot, ensureSnapshot, openFile, fileTreeData]
  )

  const search = useCallback(
    async (
      query: string,
      options: { caseSensitive?: boolean; regexp?: boolean; glob?: string } = {}
    ): Promise<SearchHit[]> => {
      try {
        await ensureSnapshot()
      } catch {
        // Snapshot failed; search whatever docs are available
      }
      const docs = snapshotDocs(projectSnapshot)

      // Augment docs with currently active open file from editor if not already present
      const open = openFile()
      if (open?.path) {
        const normOpen = open.path.replace(/^\//, '')
        if (!docs[normOpen] && !docs['/' + normOpen]) {
          const live = await readDocOverBridge(normOpen)
          if (typeof live === 'string') {
            docs[normOpen] = live
          }
        }
      }

      const hits: SearchHit[] = []
      const globPattern = options.glob?.trim()

      for (const [cleanPath, content] of Object.entries(docs)) {
        if (globPattern && !matchesGlob(cleanPath, globPattern)) {
          continue
        }

        const lines = content.split('\n')
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
                path: cleanPath,
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
              path: cleanPath,
              line: line.number,
              text: line.text,
            })
          }
        }

        if (hits.length >= 50) {
          break
        }
      }

      return hits
    },
    [projectSnapshot, ensureSnapshot, openFile]
  )

  const currentSelection = useCallback(() => {
    return selectionRef.current
  }, [])

  const proposeEdit = useCallback(
    async (edit: EditRequest): Promise<EditOutcome> => {
      const norm = edit.path.replace(/^\//, '')
      const open = openFile()
      const isTargetOpen = Boolean(open?.path && open.path.replace(/^\//, '') === norm)

      let content: string | null = null
      if (isTargetOpen) {
        content = await readDocOverBridge(norm)
      }

      if (content === null) {
        // The editor bridge had nothing, so the snapshot is the only source
        // left. An unrefreshed one reports every file as missing, which would
        // come back as a bare "noMatch" rather than the real reason.
        await ensureSnapshot()
        const docContents =
          projectSnapshot?.getDocContents?.(norm) ??
          projectSnapshot?.getDocContents?.('/' + norm)
        if (typeof docContents === 'string') {
          content = docContents
        } else {
          const docs = snapshotDocs(projectSnapshot)
          const doc = docs[norm] ?? docs['/' + norm]
          if (typeof doc !== 'string') return { status: 'noMatch' }
          content = doc
        }
      }

      let span = findUniqueSpan(content, edit.oldText)
      if (span.status !== 'found' && typeof edit.startLine === 'number' && edit.startLine >= 1) {
        // Line-scoped fallback for ambiguous anchors (e.g. duplicate \label{...}, repeated theorem environments)
        const lines = content.split('\n')
        const sIdx = edit.startLine - 1
        const anchorLineCount = edit.oldText.split('\n').length
        const windowRadius = Math.max(2, anchorLineCount + 1)

        // Try local window first
        const localEIdx = typeof edit.endLine === 'number' && edit.endLine >= edit.startLine ? edit.endLine : Math.min(lines.length, sIdx + windowRadius)
        const localSlice = lines.slice(sIdx, localEIdx)
        const localSpan = findUniqueSpan(localSlice.join('\n'), edit.oldText)

        if (localSpan.status === 'found') {
          const charOffset = lines.slice(0, sIdx).join('\n').length + (sIdx > 0 ? 1 : 0)
          span = {
            status: 'found',
            index: localSpan.index + charOffset,
            matchedLength: localSpan.matchedLength,
          }
        } else {
          const eIdx = typeof edit.endLine === 'number' && edit.endLine >= edit.startLine ? edit.endLine : lines.length
          const sliceLines = lines.slice(sIdx, eIdx)
          const scopedContent = sliceLines.join('\n')
          const scopedSpan = findUniqueSpan(scopedContent, edit.oldText)
          if (scopedSpan.status === 'found') {
            const charOffset = lines.slice(0, sIdx).join('\n').length + (sIdx > 0 ? 1 : 0)
            span = {
              status: 'found',
              index: scopedSpan.index + charOffset,
              matchedLength: scopedSpan.matchedLength,
            }
          }
        }
      }
      if (span.status !== 'found') {
        return span
      }

      const matchedLen = span.matchedLength ?? edit.oldText.length
      const resolvedOldText = content.slice(span.index, span.index + matchedLen)
      const { from: startLine, to: endLine } = spanToLineRange(
        content,
        span.index,
        matchedLen
      )

      const isAppend = edit.oldText === ''
      const action: 'create' | 'append' | 'delete' | 'edit' = isAppend
        ? 'append'
        : (!edit.newText ? 'delete' : 'edit')
      const approval = await requestApproval(
        {
          ...edit,
          oldText: isAppend ? '' : resolvedOldText,
          startLine,
          action,
          toolName: 'edit_file',
        },
        { startLine }
      )
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      let targetDocId: string | undefined
      if (fileTreeData) {
        const entity = findEntityByPath(fileTreeData, norm)
        if (entity?.type === 'doc') {
          targetDocId = entity.entity._id
          if (!isTargetOpen && openDocWithId) {
            try {
              await openDocWithId(targetDocId)
            } catch {}
            // Wait for CodeMirror view to mount the new document
            const deadline = Date.now() + 3000
            while (Date.now() < deadline) {
              const live = await readDocOverBridge(norm, targetDocId, 150)
              if (live !== null) break
              await new Promise(r => setTimeout(r, 60))
            }
          }
        }
      }

      const fromOffset = span.index
      const toOffset = span.index + matchedLen

      let applied = await applyEditOverBridge({
        path: norm,
        docId: targetDocId,
        from: startLine,
        to: endLine,
        fromOffset,
        toOffset,
        oldText: isAppend ? '' : resolvedOldText,
        replacement: edit.newText,
        isAppend,
      })

      if (applied.status === 'pathMismatch' || applied.status === 'docIdMismatch') {
        await new Promise(r => setTimeout(r, 150))
        applied = await applyEditOverBridge({
          path: norm,
          docId: targetDocId,
          from: startLine,
          to: endLine,
          fromOffset,
          toOffset,
          oldText: isAppend ? '' : resolvedOldText,
          replacement: edit.newText,
          isAppend,
        })
      }

      if (applied.status === 'applied') {
        // The document just changed, so the cached snapshot is stale. Marking
        // it so makes the next read refresh; refreshing here as well would
        // only duplicate that round trip.
        invalidateSnapshot()
        return { status: 'applied', startLine }
      }
      if (applied.status === 'timeout') {
        return {
          status: 'timeout',
          message: applied.message || 'Editor bridge timed out waiting for editor response.',
        }
      }
      if (applied.status === 'pathMismatch' || applied.status === 'docIdMismatch') {
        return {
          status: 'error',
          message: applied.message || 'Editor document mismatch during edit application.',
        }
      }
      if (applied.status === 'drifted') {
        return { status: 'drifted', message: applied.message }
      }
      return {
        status: 'error',
        message: applied.message || 'Failed to apply edit over bridge.',
      }
    },
    [
      projectSnapshot,
      fileTreeData,
      openDocWithId,
      openFile,
      requestApproval,
      ensureSnapshot,
      invalidateSnapshot,
    ]
  )

  const compile = useCallback(
    async (options?: CompileOptions): Promise<CompileOutcome> => {
      if (!startCompile) {
        throw new Error('Compilation is not available in this context.')
      }
      const signal = options?.signal

      const cancel = () => {
        // Tell CLSI to stop, or the build keeps burning a compiler slot after
        // the run that asked for it is gone. Failure to stop is not worth
        // failing the cancel.
        try {
          stopCompile?.()
        } catch {
          // ignore
        }
        throw new Error('Compile cancelled')
      }
      if (signal?.aborted) cancel()

      // DocumentCompiler.compile() returns without doing anything when a build
      // is already running, and clearing the cache under a running LaTeX would
      // delete files it is still reading. Either way the editor has to be idle
      // before this compile is the one that counts.
      if (compilingRef.current) {
        const idle = await waitFor(() => !compilingRef.current, {
          timeoutMs: COMPILE_IDLE_TIMEOUT_MS,
          signal,
        })
        if (!idle) {
          return toCompileOutcome(null, COMPILE_SKIPPED)
        }
      }

      if (options?.clean && clearCache) {
        // Always resolves: DocumentCompiler.clearCache() swallows its own
        // failure and records it as the editor error 'clear-cache', which the
        // status check below deliberately ignores. A clear that did not work
        // still leaves a normal incremental compile to try.
        await clearCache()
        if (signal?.aborted) cancel()
      }

      // Snapshots taken after the clear, so a stale result from the previous
      // compile — or the 'clear-cache' error the clear itself may have set —
      // cannot be mistaken for this one.
      const initialOptions = lastCompileOptionsRef.current
      const initialLogEntries = logEntriesRef.current
      const initialError = compileErrorRef.current
      const initialFinished = compileFinishedRef.current

      // Not awaited: the response is observed through the waits below, and
      // awaiting would only delay that observation. DocumentCompiler never
      // rejects — it records its own failures as the editor error.
      startCompile()

      // Three wake conditions because no single one covers every path:
      //
      // - a new `lastCompileOptions` identity means a response landed. This is
      //   the normal path, and it is the only signal that distinguishes "the
      //   compile I started" from "the one already on screen".
      // - a changed editor error means the request itself failed before a
      //   response existed (CLSI unreachable, 429), where `data` never updates.
      // - a build finishing, counted by the effect above. This catches a repeat
      //   failure, where the error string is identical to the previous one and
      //   so never reads as changed.
      const responded = await waitFor(
        () =>
          lastCompileOptionsRef.current !== initialOptions ||
          compileErrorRef.current !== initialError ||
          compileFinishedRef.current !== initialFinished,
        { timeoutMs: COMPILE_TIMEOUT_MS, signal }
      )

      // Woken by an error or by the finished counter rather than by a response
      // means the request never produced one: CLSI unreachable, rate limited, a
      // 429 on the POST. DocumentCompiler cleared the log in that case, so
      // waiting for entries would burn the whole settle budget on a parse that
      // can never happen — the editor's error is already the diagnosis.
      //
      // Read without a baseline comparison, deliberately. DocumentCompiler
      // clears the error on every successful response and then records the
      // failing status, so whatever is set now describes this compile; a second
      // `timedout` after a first one would otherwise compare equal to its own
      // snapshot and read as a clean success.
      if (!responded || lastCompileOptionsRef.current === initialOptions) {
        return resolveCompileOutcome({
          kind: 'no-response',
          timedOut: !responded,
          error: compileErrorRef.current as string | undefined,
        })
      }

      // The response landed; the log is fetched and parsed afterwards, so
      // logEntries is still undefined or still the previous compile's until
      // that finishes. A clean build legitimately parses to zero entries, so
      // "settled" means a new object, never "has entries".
      const settled = await waitFor(
        () =>
          Boolean(logEntriesRef.current) &&
          logEntriesRef.current !== initialLogEntries,
        { timeoutMs: LOG_SETTLE_TIMEOUT_MS, signal }
      )

      return resolveCompileOutcome(
        {
          kind: 'responded',
          settled,
          entries: logEntriesRef.current,
          // Read after the settle rather than before: the editor error is
          // assigned in the same effect that starts the log fetch, so the value
          // seen above can still be the previous compile's.
          error: compileErrorRef.current as string | undefined,
        },
        rawLogRef.current
      )
    },
    [startCompile, clearCache, stopCompile]
  )

  const lastCompile = useCallback((): LastCompile | null => {
    return toLastCompile(logEntriesRef.current, rawLogRef.current)
  }, [])

  const index = useCallback(async (): Promise<ProjectIndex> => {
    try {
      await ensureSnapshot()
    } catch {
      // Snapshot failed; index available docs
    }
    const stringDocs = snapshotDocs(projectSnapshot)

    // Augment with active open document if missing from snapshot
    const open = openFile()
    if (open?.path) {
      const normOpen = open.path.replace(/^\//, '')
      if (!stringDocs[normOpen] && !stringDocs['/' + normOpen]) {
        const live = await readDocOverBridge(normOpen)
        if (typeof live === 'string') {
          stringDocs[normOpen] = live
        }
      }
    }

    indexRef.current = buildProjectIndex(
      { docs: stringDocs, rootPath: rootDocPath() },
      indexRef.current
    )
    return indexRef.current
  }, [projectSnapshot, rootDocPath, ensureSnapshot, openFile])

  const createFile = useCallback(
    async (request: { path: string; content: string }): Promise<EditOutcome> => {
      const approval = await requestApproval(
        {
          path: request.path,
          oldText: '',
          newText: request.content,
          action: 'create',
          toolName: 'create_file',
          startLine: 1,
        },
        { startLine: 1 }
      )
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      const norm = request.path.replace(/^\//, '')
      const segments = norm.split('/')
      const fileName = segments.pop()!

      if (!project?._id || !fileTreeData) {
        return { status: 'error', message: 'Project or file tree not loaded.' }
      }

      let parentFolderId: string
      try {
        parentFolderId = await ensureFolderPath(project._id, fileTreeData, segments)
      } catch (err: any) {
        return {
          status: 'error',
          message: err?.message || 'Failed to create parent directories.',
        }
      }

      let createdDoc: any
      try {
        createdDoc = await syncCreateEntity(project._id, parentFolderId, {
          endpoint: 'doc',
          name: fileName,
        })
      } catch (err: any) {
        return {
          status: 'error',
          message: err?.message || `Failed to create file "${request.path}".`,
        }
      }

      if (!createdDoc?._id) {
        return {
          status: 'error',
          message: `Failed to create file entity for "${request.path}".`,
        }
      }

      // The project gained a file, so any cached snapshot predates it. Without
      // this a read taken straight afterwards would not see the new file.
      invalidateSnapshot()

      // If openDoc is available, switch to the newly created document and populate initial content
      if (openDoc) {
        try {
          await openDoc(createdDoc)
          const applied = await applyEditOverBridge({
            path: norm,
            docId: createdDoc._id,
            from: 1,
            to: 1,
            oldText: '',
            replacement: request.content,
          })

          if (applied.status === 'applied') {
            return { status: 'applied', startLine: 1 }
          }
          if (applied.status === 'timeout') {
            return {
              status: 'timeout',
              message:
                applied.message ||
                'Editor bridge timed out populating new file content.',
            }
          }
          if (applied.status === 'pathMismatch' || applied.status === 'docIdMismatch') {
            return {
              status: 'error',
              message:
                applied.message ||
                'Active editor document did not switch to new file.',
            }
          }
          if (applied.status === 'drifted') {
            return { status: 'drifted', message: applied.message }
          }
          return {
            status: 'error',
            message: applied.message || 'Failed to populate content in new file.',
          }
        } catch (err: any) {
          return {
            status: 'error',
            message: err?.message || 'Error opening newly created file.',
          }
        }
      }

      return { status: 'applied', startLine: 1 }
    },
    [fileTreeData, project?._id, openDoc, requestApproval, invalidateSnapshot]
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
