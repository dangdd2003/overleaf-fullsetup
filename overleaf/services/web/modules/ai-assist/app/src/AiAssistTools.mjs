import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import ProjectOptionsHandler from '../../../../app/src/Features/Project/ProjectOptionsHandler.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import Settings from '@overleaf/settings'
import { LatexLogParser } from './LatexLogParser.mjs'

const FORBIDDEN_ACCOUNT_KEYS = new Set([
  'password',
  'email',
  'emails',
  'first_name',
  'last_name',
  'role',
  'institution',
  'tokens',
  'sessions',
  'saml',
  'billing',
  'subscription',
  'admin',
])

const ALLOWED_APPEARANCE_KEYS = new Set([
  'overallTheme',
  'editorTheme',
  'editorLightTheme',
  'editorDarkTheme',
  'darkModePdf',
  'fontSize',
  'fontFamily',
  'lineHeight',
])

const ALLOWED_COMPILER_KEYS = new Set([
  'compiler',
  'imageName',
  'rootDocPath',
  'rootDocId',
  'draft',
  'stopOnFirstError',
])

const ALLOWED_EDITOR_KEYS = new Set([
  'mode',
  'autoComplete',
  'autoPairDelimiters',
  'syntaxValidation',
  'pdfViewer',
  'mathPreview',
  'breadcrumbs',
  'editorTabs',
  'spellCheckLanguage',
])

function normalizeLines(str) {
  return (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function cleanLineNumbers(text) {
  return (text || '').replace(/^\s*\d+[:|]\s?/gm, '')
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  let count = 0
  let index = normH.indexOf(normN)
  while (index !== -1) {
    count += 1
    index = normH.indexOf(normN, index + normN.length)
  }
  if (count > 0) return count

  const trimH = normH
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const trimN = normN
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  index = trimH.indexOf(trimN)
  while (index !== -1) {
    count += 1
    index = trimH.indexOf(trimN, index + trimN.length)
  }
  return count
}

export function cleanOldText(text) {
  if (!text) return ''
  let cleaned = cleanLineNumbers(text)
  // Normalize double-escaped LaTeX backslashes e.g. \\centering -> \centering
  cleaned = cleaned.replace(/\\\\([a-zA-Z@]+)/g, '\\$1')
  return cleaned
}

export function tokenizeCode(str) {
  const tokens = []
  const re = /\\[a-zA-Z@]+|\\end\{[^}]*\}|\\begin\{[^}]*\}|\{[^}]*\}|[^\s\\{}]+|\\/g
  let m
  while ((m = re.exec(str)) !== null) {
    tokens.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return tokens
}

export function findWhitespaceAgnosticAnchor(haystack, needle) {
  if (!needle || !haystack) return null
  const cleanedNeedle = cleanOldText(needle)
  const hTokens = tokenizeCode(haystack)
  const nTokens = tokenizeCode(cleanedNeedle)

  if (nTokens.length === 0 || hTokens.length < nTokens.length) return null

  // Normalize tokens: strip redundant backslashes on commands
  const normN = nTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))
  const normH = hTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))

  const matchIndices = []

  for (let i = 0; i <= normH.length - normN.length; i++) {
    let match = true
    for (let j = 0; j < normN.length; j++) {
      if (normH[i + j] !== normN[j]) {
        match = false
        break
      }
    }
    if (match) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    const endIdx = startIdx + normN.length - 1
    const charStart = hTokens[startIdx].start
    const charEnd = hTokens[endIdx].end
    return {
      matchedText: haystack.slice(charStart, charEnd),
      charStart,
      charEnd,
    }
  }

  return null
}

export function locateAnchorInText(docText, anchor) {
  if (!docText || !anchor) return null

  // 1. Exact match
  let count = countOccurrences(docText, anchor)
  if (count === 1) return { type: 'exact', anchor }

  // 2. Cleaned backslashes / line numbers
  const cleaned = cleanOldText(anchor)
  if (cleaned && cleaned !== anchor) {
    count = countOccurrences(docText, cleaned)
    if (count === 1) return { type: 'cleaned', anchor: cleaned }
  }

  // 3. Fuzzy anchor matching
  const fuzzy = findFuzzyUniqueAnchor(docText, anchor) || (cleaned ? findFuzzyUniqueAnchor(docText, cleaned) : null)
  if (fuzzy) return { type: 'fuzzy', anchor: fuzzy }

  // 4. Whitespace-agnostic token matching
  const wsMatch = findWhitespaceAgnosticAnchor(docText, anchor) || (cleaned ? findWhitespaceAgnosticAnchor(docText, cleaned) : null)
  if (wsMatch) {
    return {
      type: 'whitespace',
      anchor: wsMatch.matchedText,
      charStart: wsMatch.charStart,
      charEnd: wsMatch.charEnd,
    }
  }

  return null
}

export function findMatchingLines(haystack, needle) {
  if (!needle) return []
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  const hLines = normH.split('\n')
  const nFirst = normN.split('\n')[0].trim()
  const results = []

  for (let i = 0; i < hLines.length; i++) {
    if (hLines[i].trim() === nFirst) {
      results.push(i + 1)
    }
  }
  return results.slice(0, 5)
}

export function findFuzzyUniqueAnchor(haystack, needle) {
  if (!needle) return null
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)

  // 1. Try stripped line numbers
  const stripped = cleanLineNumbers(normN)
  if (stripped && stripped !== normN) {
    const strippedOccurrences = countOccurrences(normH, stripped)
    if (strippedOccurrences === 1) {
      return stripped
    }
  }

  // 2. Line-by-line trimmed matching against haystack lines
  const hLines = normH.split('\n')
  const nLines = (stripped || normN).split('\n')

  while (nLines.length > 1 && nLines[nLines.length - 1].trim() === '') {
    nLines.pop()
  }
  while (nLines.length > 1 && nLines[0].trim() === '') {
    nLines.shift()
  }

  const trimmedN = nLines.map(l => l.trim())
  if (trimmedN.length === 0 || trimmedN.every(l => l === '')) return null

  const matchIndices = []

  for (let i = 0; i <= hLines.length - trimmedN.length; i++) {
    let matches = true
    for (let j = 0; j < trimmedN.length; j++) {
      if (hLines[i + j].trim() !== trimmedN[j]) {
        matches = false
        break
      }
    }
    if (matches) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    return hLines.slice(startIdx, startIdx + trimmedN.length).join('\n')
  }

  return null
}

function excerptAround(rawLog, needle, radius = 3) {
  if (!rawLog || !needle) return null
  const lines = rawLog.split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  if (index === -1) return null

  return lines
    .slice(Math.max(0, index - radius), index + radius + 1)
    .join('\n')
}

export class AiAssistTools {
  constructor({
    docUpdater = DocumentUpdaterHandler.promises,
    entityHandler = ProjectEntityHandler.promises,
    projectGetter = ProjectGetter.promises,
    editorController = EditorController,
    compileManager = CompileManager.promises,
    clsiManager = ClsiManager.promises,
    projectOptionsHandler = ProjectOptionsHandler.promises,
    userModel = User,
    settings = Settings,
  } = {}) {
    this.docUpdater = docUpdater
    this.entityHandler = entityHandler
    this.projectGetter = projectGetter
    this.editorController = editorController
    this.compileManager = compileManager
    this.clsiManager = clsiManager
    this.projectOptionsHandler = projectOptionsHandler
    this.userModel = userModel
    this.settings = settings
    this.lastCompileResult = new Map()
  }

  async _getRootFolderId(projectId) {
    try {
      if (this.projectGetter?.getProject) {
        const project = await this.projectGetter.getProject(projectId, { rootFolder: true })
        return project?.rootFolder?.[0]?._id ?? null
      }
    } catch {
      // ignore
    }
    return null
  }

  async _resolveValidUserId(projectId, userId) {
    if (userId && /^[0-9a-f]{24}$/i.test(String(userId))) {
      return String(userId)
    }
    return null
  }

  async _getDocsList(projectId) {
    const raw = await this.entityHandler.getAllDocs(projectId)
    if (Array.isArray(raw)) {
      return raw.map(d => ({
        _id: d._id,
        name: d.name || '',
        path: (d.name || '').replace(/^\//, ''),
        lines: d.lines || [],
      }))
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([docPath, d]) => ({
        _id: d._id,
        name: d.name || '',
        path: docPath.replace(/^\//, ''),
        lines: d.lines || [],
      }))
    }
    return []
  }

  async resolveEditTarget(args, { projectId }) {
    if (!args || !args.oldText || typeof args.oldText !== 'string' || !args.oldText.trim()) {
      return null
    }
    const doc = await this._resolveDoc(projectId, args.path)
    if (doc) {
      let docText = (doc.lines || []).join('\n')
      try {
        const fetched = await this.docUpdater.getDocument(projectId, doc._id)
        if (fetched?.lines) docText = fetched.lines.join('\n')
      } catch {}
      const match = locateAnchorInText(docText, args.oldText)
      if (match) return { path: doc.path, doc }
    }

    // Search other project files
    const allDocs = await this._getDocsList(projectId)
    for (const other of allDocs) {
      if (doc && String(other._id) === String(doc._id)) continue
      let otherText = (other.lines || []).join('\n')
      try {
        const fetched = await this.docUpdater.getDocument(projectId, other._id)
        if (fetched?.lines) otherText = fetched.lines.join('\n')
      } catch {}
      const match = locateAnchorInText(otherText, args.oldText)
      if (match) {
        return { path: other.path, doc: other }
      }
    }
    return null
  }

  async _resolveDoc(projectId, targetPath) {
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return null
    }
    const normalized = targetPath.trim().replace(/^\//, '')
    if (this.entityHandler.getDocIdByPath) {
      try {
        const docId = await this.entityHandler.getDocIdByPath(projectId, normalized)
        if (docId) {
          const docs = await this._getDocsList(projectId)
          const found = docs.find(d => String(d._id) === String(docId))
          if (found) return found
          return { _id: docId, path: normalized, name: normalized.split('/').pop(), lines: [] }
        }
      } catch {
        // Fall back to scanning the docs list
      }
    }
    const docs = await this._getDocsList(projectId)
    const exact = docs.find(d => d.path === normalized || d.name === normalized)
    if (exact) return exact
    const suffix = docs.find(d => d.path.endsWith(normalized) || normalized.endsWith(d.name))
    return suffix || null
  }

  async _resolveDocId(projectId, path) {
    const doc = await this._resolveDoc(projectId, path)
    return doc?._id ?? null
  }

  async execute(name, args = {}, { projectId, userId: rawUserId }) {
    const userId = await this._resolveValidUserId(projectId, rawUserId)
    if (!userId) {
      return { error: 'A valid authenticated user context is required to execute tools.' }
    }

    // Path sanitization for file operations
    if (args.path && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        return { error: 'Path traversal forbidden: file path cannot reference parent directories.' }
      }
    }

    switch (name) {
      case 'read_file': {
        const doc = await this._resolveDoc(projectId, args.path)
        if (!doc) return { error: `File not found: ${args.path}` }
        let lines = doc.lines
        try {
          const fetched = await this.docUpdater.getDocument(projectId, doc._id)
          if (fetched?.lines) lines = fetched.lines
        } catch {
          // keep fallback lines
        }
        const totalLines = lines.length
        const from = Math.max(1, Math.min(args.from || 1, totalLines || 1))
        const to = Math.min(args.to || totalLines, totalLines)
        const sliced = lines.slice(from - 1, to)
        return {
          path: args.path,
          from,
          to,
          totalLines,
          content: sliced.join('\n'),
        }
      }

      case 'search_text':
      case 'search_project': {
        const docs = await this._getDocsList(projectId)
        const hits = []
        for (const doc of docs) {
          let lines = doc.lines
          try {
            const fetched = await this.docUpdater.getDocument(projectId, doc._id)
            if (fetched?.lines) lines = fetched.lines
          } catch {
            // keep fallback lines
          }
          lines.forEach((line, idx) => {
            if (line.includes(args.query)) {
              hits.push({ path: doc.path, line: idx + 1, text: line.trim() })
            }
          })
        }
        return { hits: hits.slice(0, 50) }
      }

      case 'list_files':
      case 'project_map': {
        const docs = await this._getDocsList(projectId)
        const files = docs.map(doc => ({
          path: doc.path,
          lines: doc.lines?.length || 0,
          type: 'doc',
        }))
        return { files }
      }

      case 'edit_file': {
        if (args._parseError) {
          return {
            error: 'Tool arguments were truncated or invalid JSON. Please perform smaller edits or edit one section at a time.',
          }
        }
        if (!args.path || typeof args.path !== 'string' || !args.path.trim()) {
          return { error: "Parameter 'path' is required for edit_file." }
        }

        let doc = await this._resolveDoc(projectId, args.path)
        let docText = ''
        if (doc) {
          let lines = doc.lines || []
          try {
            const docObj = await this.docUpdater.getDocument(projectId, doc._id)
            if (docObj?.lines) lines = docObj.lines
          } catch {}
          docText = lines.join('\n')
        }

        // Whole file replacement:
        const hasDocClass = (args.newText || '').includes('\\documentclass')
        const isDocEmpty = !doc || docText.trim().length === 0
        const isFullFileReplace =
          (typeof args.oldText === 'string' && args.oldText.trim().length > 0 && normalizeLines(args.oldText).trim() === normalizeLines(docText).trim()) ||
          ((args.oldText === '' || args.oldText === undefined) && (hasDocClass || isDocEmpty))

        if (isFullFileReplace && doc) {
          const updatedLines = (args.newText || '').split('\n')
          await this.docUpdater.setDocument(projectId, doc._id, userId, updatedLines, 'ai-assist')
          return { status: 'applied', path: doc.path }
        }

        // Append mode: only when oldText is explicitly empty string "" and NOT full-file LaTeX
        if (args.oldText === '' && doc) {
          const appended = docText.endsWith('\n') || docText.length === 0
            ? docText + (args.newText || '')
            : docText + '\n' + (args.newText || '')
          await this.docUpdater.setDocument(projectId, doc._id, userId, appended.split('\n'), 'ai-assist')
          return { status: 'applied', path: doc.path }
        }

        if (typeof args.oldText !== 'string') {
          return {
            error: `Parameter 'oldText' is required to replace text in ${args.path}. Provide the exact snippet from the file to replace, or pass the full file content if replacing the entire file.`,
          }
        }

        let targetAnchor = args.oldText
        let resolvedDoc = doc
        let resolvedDocText = docText
        let targetMatch = doc ? locateAnchorInText(resolvedDocText, targetAnchor) : null

        // If not found in target file, search other project documents
        if (!targetMatch) {
          const allDocs = await this._getDocsList(projectId)
          for (const other of allDocs) {
            if (doc && String(other._id) === String(doc._id)) continue
            let otherText = (other.lines || []).join('\n')
            try {
              const fetched = await this.docUpdater.getDocument(projectId, other._id)
              if (fetched?.lines) otherText = fetched.lines.join('\n')
            } catch {}

            const candidateMatch = locateAnchorInText(otherText, targetAnchor)
            if (candidateMatch) {
              resolvedDoc = other
              resolvedDocText = otherText
              targetMatch = candidateMatch
              break
            }
          }
        }

        if (!targetMatch || !resolvedDoc) {
          if (resolvedDocText) {
            const matches = countOccurrences(resolvedDocText, targetAnchor)
            if (matches > 1) {
              const occurrences = findMatchingLines(resolvedDocText, targetAnchor)
              return {
                error: `That text appears ${matches} times in ${resolvedDoc.path} (around line(s) ${occurrences.join(', ')}). Include more surrounding context lines so the anchor is unique.`,
              }
            }
          }
          return {
            error: `Could not find target text in ${args.path} or any other project file. If replacing text, copy an existing anchor line that appears in the file.`,
          }
        }

        // Perform replacement
        let replaced
        if (targetMatch.charStart !== undefined && targetMatch.charEnd !== undefined) {
          replaced = resolvedDocText.slice(0, targetMatch.charStart) + (args.newText || '') + resolvedDocText.slice(targetMatch.charEnd)
        } else {
          const matchedAnchor = targetMatch.anchor
          const normDoc = normalizeLines(resolvedDocText)
          const normAnchor = normalizeLines(matchedAnchor)
          if (normDoc.includes(normAnchor)) {
            replaced = normDoc.replace(normAnchor, args.newText || '')
          } else {
            replaced = resolvedDocText.replace(matchedAnchor, args.newText || '')
          }
        }

        await this.docUpdater.setDocument(projectId, resolvedDoc._id, userId, replaced.split('\n'), 'ai-assist')
        const note = doc && resolvedDoc.path !== doc.path
          ? `Text was located in '${resolvedDoc.path}' (redirected from '${args.path}').`
          : undefined
        return { status: 'applied', path: resolvedDoc.path, ...(note ? { note } : {}) }
      }

      case 'create_file': {
        const lines = (args.content || '').split('\n')
        const normalizedPath = (args.path || '').replace(/^\//, '')

        if (this.editorController?.promises?.upsertDocWithPath) {
          try {
            const doc = await this.editorController.promises.upsertDocWithPath(
              projectId,
              normalizedPath,
              lines,
              'ai-assist',
              userId
            )
            return { status: 'applied', path: args.path, docId: doc?._id }
          } catch (err) {
            // fall through to addDoc
          }
        }

        const rootFolderId = (await this._getRootFolderId(projectId)) || 'root-folder'
        return new Promise((resolve, reject) => {
          this.editorController.addDoc(
            projectId,
            rootFolderId,
            normalizedPath,
            lines,
            'ai-assist',
            userId,
            (err, newDoc) => {
              if (err) return reject(err)
              resolve({ status: 'applied', path: args.path, docId: newDoc?._id })
            }
          )
        })
      }

      case 'compile_project': {
        const result = await this.compileManager.compile(projectId, userId, {})
        let errors = []
        let warnings = []
        let rawLog = ''

        const logFile = (result.outputFiles || []).find(f => f.path === 'output.log' || f.path?.endsWith('.log'))
        if (logFile && result.buildId && this.clsiManager?.getOutputFileStream) {
          try {
            const stream = await this.clsiManager.getOutputFileStream(
              projectId,
              userId,
              result.clsiServerId,
              result.buildId,
              logFile.path
            )
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
            rawLog = Buffer.concat(chunks).toString('utf8')
            const parsed = LatexLogParser.parse(rawLog, { ignoreDuplicates: true })
            errors = (parsed.errors || []).map(e => ({
              file: e.file || null,
              line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
              message: e.message || '',
            }))
            warnings = (parsed.warnings || []).map(w => ({
              file: w.file || null,
              line: typeof w.line === 'number' ? w.line : (parseInt(w.line, 10) || null),
              message: w.message || '',
            }))
          } catch (err) {
            // Log fetch failure is non-fatal
          }
        }

        const compileStatus = errors.length > 0 ? 'failure' : (result.status === 'success' ? 'success' : result.status)
        this.lastCompileResult.set(projectId, {
          status: compileStatus,
          errors,
          warnings,
          rawLog,
        })

        const maxReported = 20
        return {
          status: compileStatus,
          errorCount: errors.length,
          warningCount: warnings.length,
          errors: errors.slice(0, maxReported),
          warnings: warnings.slice(0, maxReported),
          message:
            errors.length === 0
              ? (warnings.length > 0
                  ? `The project compiled with 0 errors and ${warnings.length} warning(s).`
                  : 'The project compiled without errors.')
              : `The project compiled with ${errors.length} error(s) and ${warnings.length} warning(s).`,
        }
      }

      case 'get_compile_result':
      case 'get_compile_log': {
        let compile = this.lastCompileResult.get(projectId)
        if (!compile) {
          try {
            await this.execute('compile_project', {}, { projectId, userId: rawUserId })
            compile = this.lastCompileResult.get(projectId)
          } catch {
            // ignore
          }
        }

        if (!compile) {
          return {
            status: 'none',
            message: 'The project has not been compiled in this session. Call compile_project to build it.',
          }
        }

        const severity = args.severity || 'all'
        const limit = args.limit || args.maxEntries || 20
        const includeRaw = Boolean(args.includeRaw)

        const errors = compile.errors.slice(0, limit)
        const warnings = compile.warnings.slice(0, limit)

        const decorate = (entries) => {
          if (!includeRaw || !compile.rawLog) return entries
          return entries.map(e => {
            const excerpt = excerptAround(compile.rawLog, e.message)
            return excerpt ? { ...e, excerpt } : e
          })
        }

        const outcome = {
          status: compile.status,
          errorCount: compile.errors.length,
          warningCount: compile.warnings.length,
          truncated: compile.errors.length > limit || compile.warnings.length > limit,
        }

        if (severity === 'all' || severity === 'errors') {
          outcome.errors = decorate(errors)
        }
        if (severity === 'all' || severity === 'warnings') {
          outcome.warnings = decorate(warnings)
        }

        return outcome
      }

      case 'get_outline': {
        const docs = await this._getDocsList(projectId)
        const rootDoc = docs.find(d => d.name === 'main.tex' || d.path === 'main.tex') || docs[0]
        return { rootDoc: rootDoc?.path || rootDoc?.name || 'main.tex', sections: [] }
      }

      case 'get_packages': {
        return { packages: [] }
      }

      case 'get_references': {
        return { references: [] }
      }

      case 'get_project_settings': {
        const project = await this.projectGetter.getProject(projectId, {
          compiler: 1,
          imageName: 1,
          rootDoc_id: 1,
          draft: 1,
          stopOnFirstError: 1,
          spellCheckLanguage: 1,
          name: 1,
          description: 1,
        })
        if (!project) return { error: 'Project not found' }

        let rootDocPath = null
        try {
          const allDocs = await this._getDocsList(projectId)
          if (project.rootDoc_id) {
            const root = allDocs.find(d => String(d._id) === String(project.rootDoc_id))
            if (root) rootDocPath = root.path
          }
        } catch {}

        let user = null
        if (userId) {
          try {
            user = await this.userModel.findById(userId).select('ace').exec()
          } catch {}
        }
        const ace = user?.ace || {}

        return {
          status: 'ok',
          settings: {
            compiler: {
              compiler: project.compiler || 'pdflatex',
              imageName: project.imageName || null,
              rootDocId: project.rootDoc_id ? String(project.rootDoc_id) : null,
              rootDocPath,
              draft: Boolean(project.draft),
              stopOnFirstError: Boolean(project.stopOnFirstError),
            },
            appearance: {
              overallTheme: ace.overallTheme || 'system',
              editorTheme: ace.theme || 'textmate',
              editorLightTheme: ace.lightTheme || 'textmate',
              editorDarkTheme: ace.darkTheme || 'overleaf_dark',
              darkModePdf: ace.darkModePdf ?? false,
              fontSize: ace.fontSize != null ? Number(ace.fontSize) : 12,
              fontFamily: ace.fontFamily || null,
              lineHeight: ace.lineHeight || null,
            },
            editor: {
              mode: ace.mode || 'none',
              autoComplete: ace.autoComplete ?? true,
              autoPairDelimiters: ace.autoPairDelimiters ?? true,
              syntaxValidation: ace.syntaxValidation ?? true,
              pdfViewer: ace.pdfViewer || 'pdfjs',
              mathPreview: ace.mathPreview ?? true,
              breadcrumbs: ace.breadcrumbs ?? true,
              editorTabs: ace.editorTabs ?? true,
              spellCheckLanguage: ace.spellCheckLanguage || 'en',
            },
            spelling: {
              spellCheckLanguage: project.spellCheckLanguage || null,
            },
            name: project.name || '',
            description: project.description || '',
          },
        }
      }

      case 'configure_appearance_settings': {
        if (!userId) return { error: 'User context is required to configure appearance settings.' }

        // Security guardrail: explicitly block account credentials and settings
        const providedKeys = Object.keys(args || {})
        const forbiddenFound = providedKeys.filter(k => FORBIDDEN_ACCOUNT_KEYS.has(k.toLowerCase()))
        if (forbiddenFound.length > 0) {
          return {
            error: `Cannot modify account settings (${forbiddenFound.join(', ')}). Only appearance preferences may be changed.`,
          }
        }

        const validKeys = providedKeys.filter(k => ALLOWED_APPEARANCE_KEYS.has(k))
        if (validKeys.length === 0) {
          return { error: 'Supply at least one valid appearance setting to configure.' }
        }

        let user = null
        try {
          user = await this.userModel.findById(userId).exec()
        } catch {}
        if (!user) return { error: 'User not found' }

        user.ace = user.ace || {}
        const updated = {}

        if (args.overallTheme !== undefined) {
          const lower = String(args.overallTheme).toLowerCase().trim()
          let norm = String(args.overallTheme)
          if (lower === 'dark' || lower === 'default') norm = ''
          else if (lower === 'light' || lower === 'light-') norm = 'light-'
          else if (lower === 'system') norm = 'system'
          user.ace.overallTheme = norm
          updated.overallTheme = norm
        }
        if (args.editorTheme !== undefined) {
          user.ace.theme = String(args.editorTheme)
          updated.editorTheme = user.ace.theme
        }
        if (args.editorLightTheme !== undefined) {
          user.ace.lightTheme = String(args.editorLightTheme)
          updated.editorLightTheme = user.ace.lightTheme
        }
        if (args.editorDarkTheme !== undefined) {
          user.ace.darkTheme = String(args.editorDarkTheme)
          updated.editorDarkTheme = user.ace.darkTheme
        }
        if (args.darkModePdf !== undefined) {
          user.ace.darkModePdf = Boolean(args.darkModePdf)
          updated.darkModePdf = user.ace.darkModePdf
        }
        if (args.fontSize !== undefined) {
          const fs = Number(args.fontSize)
          if (Number.isFinite(fs) && fs > 0) {
            user.ace.fontSize = fs
            updated.fontSize = fs
          }
        }
        if (args.fontFamily !== undefined) {
          user.ace.fontFamily = args.fontFamily ? String(args.fontFamily) : null
          updated.fontFamily = user.ace.fontFamily
        }
        if (args.lineHeight !== undefined) {
          user.ace.lineHeight = args.lineHeight ? String(args.lineHeight) : null
          updated.lineHeight = user.ace.lineHeight
        }

        if (typeof user.save === 'function') {
          await user.save()
        }

        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Appearance settings updated successfully.',
        }
      }

      case 'configure_compiler_settings': {
        const providedKeys = Object.keys(args || {})
        const validKeys = providedKeys.filter(k => ALLOWED_COMPILER_KEYS.has(k))
        if (validKeys.length === 0) {
          return { error: 'Supply at least one compiler setting to configure.' }
        }

        const project = await this.projectGetter.getProject(projectId, { _id: 1 })
        if (!project) return { error: 'Project not found' }

        const updated = {}

        if (args.compiler != null) {
          const comp = String(args.compiler).toLowerCase()
          if (this.editorController?.promises?.setCompiler) {
            await this.editorController.promises.setCompiler(projectId, comp)
          } else if (this.projectOptionsHandler?.setCompiler) {
            await this.projectOptionsHandler.setCompiler(projectId, comp)
          }
          updated.compiler = comp
        }

        if (args.imageName != null) {
          const img = String(args.imageName)
          if (this.editorController?.promises?.setImageName) {
            await this.editorController.promises.setImageName(projectId, img)
          } else if (this.projectOptionsHandler?.setImageName) {
            await this.projectOptionsHandler.setImageName(projectId, img)
          }
          updated.imageName = img
        }

        let effectiveRootDocId = args.rootDocId
        if (!effectiveRootDocId && args.rootDocPath) {
          const doc = await this._resolveDoc(projectId, args.rootDocPath)
          if (!doc) return { error: `Root document not found at path: ${args.rootDocPath}` }
          effectiveRootDocId = doc._id
        }
        if (effectiveRootDocId != null) {
          if (this.editorController?.promises?.setRootDoc) {
            await this.editorController.promises.setRootDoc(projectId, effectiveRootDocId)
          } else if (this.editorController?.setRootDoc) {
            await new Promise((resolve, reject) => {
              this.editorController.setRootDoc(projectId, effectiveRootDocId, err => (err ? reject(err) : resolve()))
            })
          }
          updated.rootDocId = String(effectiveRootDocId)
          if (args.rootDocPath) updated.rootDocPath = args.rootDocPath
        }

        if (args.draft !== undefined) {
          const draftVal = Boolean(args.draft)
          if (this.projectOptionsHandler?.setDraft) {
            await this.projectOptionsHandler.setDraft(projectId, draftVal)
          }
          updated.draft = draftVal
        }

        if (args.stopOnFirstError !== undefined) {
          const stopVal = Boolean(args.stopOnFirstError)
          if (this.projectOptionsHandler?.setStopOnFirstError) {
            await this.projectOptionsHandler.setStopOnFirstError(projectId, stopVal)
          }
          updated.stopOnFirstError = stopVal
        }

        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Compiler settings updated successfully.',
        }
      }

      case 'configure_editor_settings': {
        if (!userId) return { error: 'User context is required to configure editor settings.' }

        // Security guardrail: explicitly block account credentials and settings
        const providedKeys = Object.keys(args || {})
        const forbiddenFound = providedKeys.filter(k => FORBIDDEN_ACCOUNT_KEYS.has(k.toLowerCase()))
        if (forbiddenFound.length > 0) {
          return {
            error: `Cannot modify account settings (${forbiddenFound.join(', ')}). Only editor preferences may be changed by AI tools.`,
          }
        }

        const validKeys = providedKeys.filter(k => ALLOWED_EDITOR_KEYS.has(k))
        if (validKeys.length === 0) {
          return { error: 'Supply at least one valid editor setting to configure.' }
        }

        let user = null
        try {
          user = await this.userModel.findById(userId).exec()
        } catch {}
        if (!user) return { error: 'User not found' }

        user.ace = user.ace || {}
        const updated = {}

        if (args.mode !== undefined) {
          user.ace.mode = String(args.mode)
          updated.mode = user.ace.mode
        }
        if (args.autoComplete !== undefined) {
          user.ace.autoComplete = Boolean(args.autoComplete)
          updated.autoComplete = user.ace.autoComplete
        }
        if (args.autoPairDelimiters !== undefined) {
          user.ace.autoPairDelimiters = Boolean(args.autoPairDelimiters)
          updated.autoPairDelimiters = user.ace.autoPairDelimiters
        }
        if (args.syntaxValidation !== undefined) {
          user.ace.syntaxValidation = Boolean(args.syntaxValidation)
          updated.syntaxValidation = user.ace.syntaxValidation
        }
        if (args.pdfViewer !== undefined) {
          user.ace.pdfViewer = String(args.pdfViewer)
          updated.pdfViewer = user.ace.pdfViewer
        }
        if (args.mathPreview !== undefined) {
          user.ace.mathPreview = Boolean(args.mathPreview)
          updated.mathPreview = user.ace.mathPreview
        }
        if (args.breadcrumbs !== undefined) {
          user.ace.breadcrumbs = Boolean(args.breadcrumbs)
          updated.breadcrumbs = user.ace.breadcrumbs
        }
        if (args.editorTabs !== undefined) {
          user.ace.editorTabs = Boolean(args.editorTabs)
          updated.editorTabs = user.ace.editorTabs
        }
        if (args.spellCheckLanguage !== undefined) {
          user.ace.spellCheckLanguage = String(args.spellCheckLanguage)
          updated.spellCheckLanguage = user.ace.spellCheckLanguage
        }

        if (typeof user.save === 'function') {
          await user.save()
        }

        return {
          status: 'applied',
          updatedSettings: updated,
          message: 'Editor settings updated successfully.',
        }
      }

      case 'list_available_settings': {
        const compilers = this.settings?.safeCompilers || ['pdflatex', 'latex', 'xelatex', 'lualatex']
        const imageNames = (this.settings?.allowedImageNames || []).map(img => ({
          imageName: img.imageName,
          imageDesc: img.imageDesc || img.imageName,
          default: Boolean(img.default),
        }))
        const spellCheckLanguages = (this.settings?.languages || []).map(lang => ({
          code: lang.code,
          name: lang.name,
        }))
        const fontFamilies = [
          { name: 'monaco', label: 'Monaco / Menlo / Consolas' },
          { name: 'lucida', label: 'Lucida / Source Code Pro' },
          { name: 'opendyslexicmono', label: 'OpenDyslexic Mono' },
        ]
        const editorThemes = [
          'cobalt',
          'dracula',
          'eclipse',
          'monokai',
          'overleaf',
          'overleaf_dark',
          'textmate',
          'ambiance',
          'chaos',
          'chrome',
          'clouds',
          'clouds_midnight',
          'crimson_editor',
          'dawn',
          'dreamweaver',
          'github',
          'gob',
          'gruvbox',
          'idle_fingers',
          'iplastic',
          'katzenmilch',
          'kr_theme',
          'kuroir',
          'merbivore',
          'merbivore_soft',
          'mono_industrial',
          'nord_dark',
          'pastel_on_dark',
          'solarized_dark',
          'solarized_light',
          'sqlserver',
          'terminal',
          'tomorrow',
          'tomorrow_night',
          'tomorrow_night_blue',
          'tomorrow_night_bright',
          'tomorrow_night_eighties',
          'twilight',
          'vibrant_ink',
          'xcode',
        ]

        return {
          status: 'ok',
          options: {
            compilers,
            imageNames:
              imageNames.length > 0
                ? imageNames
                : [{ imageName: 'texlive-2024.1', imageDesc: 'TeX Live 2024', default: true }],
            spellCheckLanguages:
              spellCheckLanguages.length > 0
                ? spellCheckLanguages
                : [
                    { code: 'en', name: 'English' },
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
          },
        }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }

  getToolSpecs() {
    return [
      {
        name: 'get_outline',
        description: 'Extract document outline, sections, and structural hierarchy.',
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Optional section name or title to focus outline on',
            },
          },
        },
      },
      {
        name: 'get_packages',
        description: 'List all LaTeX packages imported across project documents.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_references',
        description: 'List labels, cross-references, and citations across project files.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['labels', 'refs', 'citations', 'all'],
              description: 'Kind of references to retrieve. Defaults to all.',
            },
            unresolvedOnly: {
              type: 'boolean',
              description: 'Whether to only return unresolved references',
            },
          },
        },
      },
      {
        name: 'list_files',
        description: 'List all documents and files in the project.',
        parameters: {
          type: 'object',
          properties: {
            glob: {
              type: 'string',
              description: 'Optional glob pattern to filter files by path or extension',
            },
          },
        },
      },
      {
        name: 'read_file',
        description: 'Read one text file, or a line range of one, as numbered lines.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file to read' },
            from: { type: 'number', description: 'First line, 1-indexed' },
            to: { type: 'number', description: 'Last line, inclusive' },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_text',
        description: 'Search for text across project files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query or regex pattern' },
            glob: { type: 'string', description: 'Optional glob pattern to restrict file search scope' },
            contextLines: { type: 'number', description: 'Number of context lines before and after match' },
            caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive' },
            regexp: { type: 'boolean', description: 'Whether query should be treated as a regular expression' },
          },
          required: ['query'],
        },
      },
      {
        name: 'edit_file',
        description: 'Edit a project file. Replace oldText with newText. If replacing the entire file, you can pass oldText matching the whole file or empty string "".',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file' },
            oldText: {
              type: 'string',
              description: 'The exact text to replace. Pass an empty string "" if replacing the entire file or appending content.',
            },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
      {
        name: 'create_file',
        description: 'Create a new project file with initial content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path for the new file' },
            content: { type: 'string', description: 'Initial file content' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'compile_project',
        description: 'Compile the project and check for build errors and warnings.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_compile_result',
        description: 'Get the result of the last project compilation: errors, warnings and diagnostics.',
        parameters: {
          type: 'object',
          properties: {
            severity: {
              type: 'string',
              enum: ['errors', 'warnings', 'all'],
              description: 'Which entries to return. Defaults to all.',
            },
            limit: {
              type: 'number',
              description: 'Cap per severity. Defaults to 20.',
            },
            includeRaw: {
              type: 'boolean',
              description: 'Include raw log lines around each entry',
            },
          },
        },
      },
      {
        name: 'get_project_settings',
        description:
          'Read current project settings and preferences across compiler, appearance, editor, and spelling.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'configure_appearance_settings',
        description:
          'Configure appearance and UI display preferences (overall theme, syntax themes, font size, line spacing, dark mode PDF). Account settings cannot be modified here.',
        parameters: {
          type: 'object',
          properties: {
            overallTheme: {
              type: 'string',
              enum: ['system', 'light', 'dark'],
              description: 'Overall UI theme',
            },
            editorTheme: {
              type: 'string',
              description:
                'Editor syntax theme. Overleaf supports: cobalt, dracula, eclipse, monokai, overleaf, overleaf_dark, textmate, ambiance, chaos, chrome, clouds, clouds_midnight, crimson_editor, dawn, dreamweaver, github, gob, gruvbox, idle_fingers, iplastic, katzenmilch, kr_theme, kuroir, merbivore, merbivore_soft, mono_industrial, nord_dark, pastel_on_dark, solarized_dark, solarized_light, sqlserver, terminal, tomorrow, tomorrow_night, tomorrow_night_blue, tomorrow_night_bright, tomorrow_night_eighties, twilight, vibrant_ink, xcode.',
            },
            editorLightTheme: {
              type: 'string',
              description: 'Editor syntax theme for light mode',
            },
            editorDarkTheme: {
              type: 'string',
              description: 'Editor syntax theme for dark mode',
            },
            darkModePdf: {
              type: 'boolean',
              description: 'Toggle dark mode PDF preview',
            },
            fontSize: {
              type: 'number',
              description: 'Editor font size in pixels (e.g. 10 to 24)',
            },
            fontFamily: {
              type: 'string',
              enum: ['monaco', 'lucida', 'opendyslexicmono'],
              description:
                'Editor code font family: "monaco" (Monaco / Menlo / Consolas), "lucida" (Lucida / Source Code Pro), or "opendyslexicmono" (OpenDyslexic Mono)',
            },
            lineHeight: {
              type: 'string',
              enum: ['compact', 'normal', 'spacious'],
              description: 'Editor line spacing',
            },
          },
        },
      },
      {
        name: 'configure_compiler_settings',
        description:
          'Configure compiler settings: LaTeX compiler engine (pdflatex, latex, xelatex, lualatex), TeX Live version (imageName), root document path, draft mode, and stop on first error.',
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
        },
      },
      {
        name: 'configure_editor_settings',
        description:
          'Configure editor preferences (keybinding mode, auto-complete, bracket pairing, syntax validation, PDF viewer, math preview, breadcrumbs, editor tabs, spellcheck language). Account settings cannot be modified here.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['none', 'vim', 'emacs'],
              description: 'Keybinding mode',
            },
            autoComplete: {
              type: 'boolean',
              description: 'Toggle auto-complete popup suggestions',
            },
            autoPairDelimiters: {
              type: 'boolean',
              description: 'Toggle auto-closing of brackets and quotes',
            },
            syntaxValidation: {
              type: 'boolean',
              description: 'Toggle LaTeX syntax validation',
            },
            pdfViewer: {
              type: 'string',
              enum: ['pdfjs', 'native'],
              description: 'PDF viewer mode',
            },
            mathPreview: {
              type: 'boolean',
              description: 'Toggle inline math preview tooltip',
            },
            breadcrumbs: {
              type: 'boolean',
              description: 'Toggle file breadcrumbs bar',
            },
            editorTabs: {
              type: 'boolean',
              description: 'Toggle editor tabs bar',
            },
            spellCheckLanguage: {
              type: 'string',
              description: 'Default user spell-check language code (e.g. "en", "fr")',
            },
          },
        },
      },
      {
        name: 'list_available_settings',
        description:
          'List all allowed and available options for project and editor settings: compilers, TeX Live versions, spellcheck languages, overall themes, all 40+ editor syntax themes, code fonts (fontFamilies: monaco, lucida, opendyslexicmono), line heights, font sizes, and PDF viewers.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    ]
  }
}

export default new AiAssistTools()
