import { getJSON } from '@/infrastructure/fetch-json'
import type { HighlightData } from '@/features/pdf-preview/util/types'
import { isFiniteBox } from './result-highlights'

/** What synctex needs to find the build the user is looking at. */
export type SynctexContext = {
  clsiServerId?: string | null
  editorId?: string | null
  buildId?: string | null
}

/** A source position, as synctex reports it. */
export type SourcePosition = {
  file: string
  line: number
  column?: number
}

/** Longest line range that is highlighted line by line; longer ones use both ends. */
const MAX_LINES_HIGHLIGHTED = 12

/**
 * Synctex writes a root document in a subfolder as `folder/./main.tex`. The
 * project's own paths never have the dot, so this is the only place it is
 * added or taken away.
 */
export function synctexPath(path: string, rootDocPath: string | null): string {
  const slash = rootDocPath ? rootDocPath.lastIndexOf('/') : -1
  const dir = slash === -1 ? '' : (rootDocPath as string).slice(0, slash)
  if (dir && path.startsWith(`${dir}/`)) {
    return `${dir}/./${path.slice(dir.length + 1)}`
  }
  return path
}

export function normalizeSynctexFile(file: string): string {
  return file.replace(/^\.\//, '').replace(/\/\.\//g, '/')
}

function contextParams(context: SynctexContext): URLSearchParams {
  const params = new URLSearchParams()
  if (context.clsiServerId) params.set('clsiserverid', context.clsiServerId)
  if (context.editorId) params.set('editorId', context.editorId)
  if (context.buildId) params.set('buildId', context.buildId)
  return params
}

/**
 * The source line under a point on a PDF page. `page` is 1-based; `h` and `v`
 * are PDF points, `v` measured from the top of the page, as synctex wants.
 */
export async function sourceAtPdfPoint(
  projectId: string,
  point: { page: number; h: number; v: number },
  context: SynctexContext,
  signal?: AbortSignal
): Promise<SourcePosition | null> {
  const params = contextParams(context)
  params.set('page', String(point.page))
  params.set('h', point.h.toFixed(2))
  params.set('v', point.v.toFixed(2))
  const data = await getJSON(`/project/${projectId}/sync/pdf?${params}`, {
    signal,
  })
  const first = data?.code?.[0]
  if (!first || typeof first.file !== 'string') return null
  return {
    file: normalizeSynctexFile(first.file),
    line: Number(first.line),
    ...(typeof first.column === 'number' ? { column: first.column } : {}),
  }
}

const isBox = isFiniteBox

/**
 * Where a source line lands in the PDF, as highlight boxes. For a range the
 * lines in between are included when the range is short; a long one uses its
 * two ends, which is enough to show it.
 */
export async function pdfBoxesForSource(
  projectId: string,
  target: { path: string; line: number; endLine?: number },
  rootDocPath: string | null,
  context: SynctexContext,
  signal?: AbortSignal
): Promise<HighlightData[]> {
  const end = Math.max(target.endLine ?? target.line, target.line)
  const span = end - target.line + 1
  const lines =
    span <= MAX_LINES_HIGHLIGHTED
      ? Array.from({ length: span }, (_, i) => target.line + i)
      : [target.line, end]
  const file = synctexPath(target.path, rootDocPath)
  const results = await Promise.all(
    lines.map(line => {
      const params = contextParams(context)
      params.set('file', file)
      params.set('line', String(line))
      return getJSON(`/project/${projectId}/sync/code?${params}`, {
        signal,
      }).catch(() => null)
    })
  )
  return results.flatMap((data: { pdf?: unknown } | null) =>
    Array.isArray(data?.pdf) ? data.pdf.filter(isBox) : []
  )
}
