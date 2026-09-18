function outlineLine(section) {
  return `${'  '.repeat(section.level + 1)}${section.path}:${section.line} ${section.title}`
}

function location(entry) {
  if (!entry.file) return 'unknown location'
  return entry.line ? `${entry.file}:${entry.line}` : entry.file
}

function diagnosticLines(result) {
  const lines = []
  for (const error of result.errors || []) {
    lines.push(`error ${location(error)}: ${error.message}`)
    if (error.excerpt) {
      lines.push(...error.excerpt.split('\n').map(line => `    ${line}`))
    }
  }
  for (const warning of result.warnings || []) {
    lines.push(`warning ${location(warning)}: ${warning.message}`)
  }
  return lines
}

const RENDERERS = {
  compile_project(result) {
    if (typeof result.errorCount !== 'number') return JSON.stringify(result)
    const lines = [
      result.message ||
        `Compile ${result.status}: ${result.errorCount} error(s), ${result.warningCount} warning(s).`,
    ]
    if (result.errorCount > 1) lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    const hiddenErrors = result.errorCount - (result.errors?.length ?? 0)
    const hiddenWarnings = (result.warningCount ?? 0) - (result.warnings?.length ?? 0)
    if (hiddenErrors > 0 || hiddenWarnings > 0) {
      lines.push(
        `(${hiddenErrors} more error(s) and ${hiddenWarnings} more warning(s) not shown; call get_compile_result with a higher limit)`
      )
    }
    return lines.join('\n')
  },

  get_compile_result(result) {
    if (result.status === 'none' && result.message) return result.message
    if (typeof result.errorCount !== 'number') return JSON.stringify(result)
    const lines = [
      `Last compile: ${result.status} - ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
    ]
    if (result.errorCount > 1) lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    if (result.truncated) lines.push('(more entries not shown; pass a higher limit)')
    return lines.join('\n')
  },

  edit_file(result) {
    if (result.status !== 'applied' || typeof result.startLine !== 'number') {
      return JSON.stringify(result)
    }
    const where = result.endLine
      ? `now lines ${result.startLine}-${result.endLine}`
      : `removed text at line ${result.startLine}`
    const shift = result.lineDelta
      ? ` Later lines moved by ${result.lineDelta > 0 ? '+' : ''}${result.lineDelta}; use these line numbers, not ones read before this edit.`
      : ''
    const note = result.note ? ` ${result.note}` : ''
    const header = `Applied to ${result.path}, ${where}.${shift}${note}`
    return result.excerpt ? [header, '```', result.excerpt, '```'].join('\n') : header
  },

  get_outline(result) {
    if (result.sections && result.range) {
      return [
        `section lines ${result.range.from}-${result.range.to}`,
        ...result.sections.map(outlineLine),
        result.hint ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    }
    if (result.sections) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.sections.map(outlineLine),
        ...(result.includes || []).map(
          i => `\\input ${i.from}:${i.line} -> ${i.to}${i.resolved ? '' : ' (UNRESOLVED)'}`
        ),
        ...(result.notes || []),
      ].join('\n')
    }
    return JSON.stringify(result)
  },

  get_packages(result) {
    if (!result.packages) return JSON.stringify(result)
    return [
      `documentclass: ${result.documentClass ?? 'unknown'}`,
      ...result.packages.map(pkg => `${pkg.name}  (${pkg.path}:${pkg.line})`),
    ].join('\n')
  },

  get_references(result) {
    const lines = []
    if (result.labels) {
      lines.push(...result.labels.map(l => `label ${l.key}  ${l.path}:${l.line}`))
      lines.push(...(result.duplicateLabels ?? []).map(k => `DUPLICATE label ${k}`))
    }
    if (result.refs) {
      lines.push(...result.refs.map(r => `${r.command} ${r.key}  ${r.path}:${r.line}  ${r.resolved ? 'ok' : 'UNRESOLVED'}`))
    }
    if (result.citations) {
      lines.push(...result.citations.map(c => `${c.command} ${c.key}  ${c.path}:${c.line}  ${c.resolved ? 'ok' : 'MISSING'}`))
    }
    if (result.bibKeys) {
      lines.push(...result.bibKeys.map(b => `bib ${b.key}  ${b.path}:${b.line}`))
    }
    return lines.length > 0
      ? lines.join('\n')
      : '(no labels, references, or citations found in project)'
  },

  list_files(result) {
    if (!result.files) return JSON.stringify(result)
    const rows = result.files.map(file =>
      file.type === 'binary'
        ? `${file.path}  binary`
        : `${file.path}  ${file.type}  ${file.lines ?? ''}`.trimEnd()
    )
    if (result.truncated) {
      rows.push(`(${result.total - result.files.length} more; narrow with glob=)`)
    }
    return rows.length > 0 ? rows.join('\n') : '(no files found)'
  },

  read_file(result) {
    const header = `${result.path} lines ${result.from}-${result.to} of ${result.totalLines}`
    const footer = result.nextRange
      ? `\n(truncated - call read_file with from=${result.nextRange.from}, to=${result.nextRange.to} for the rest)`
      : ''
    return [header, '```', result.content, '```'].join('\n') + footer
  },

  search_text(result) {
    if (!result || !Array.isArray(result.hits)) return JSON.stringify(result)
    if (result.hits.length === 0) return 'No matches found.'
    const lines = [`Found ${result.total ?? result.hits.length} hit(s):`]
    for (const hit of result.hits) {
      if (typeof hit === 'string') {
        lines.push(hit)
      } else {
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l, i) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
        if (Array.isArray(hit.after) && hit.after.length > 0) {
          lines.push(...hit.after.map((l, i) => `  ${hit.line + 1 + i}: ${l}`))
        }
      }
    }
    if (result.truncated) {
      lines.push(`(truncated - ${result.total - result.hits.length} more hits)`)
    }
    return lines.join('\n')
  },
}

export function renderToolResult(name, result) {
  const renderer = RENDERERS[name]
  if (!renderer || result === null || typeof result !== 'object' || result.error) {
    return JSON.stringify(result)
  }
  try {
    return renderer(result)
  } catch {
    return JSON.stringify(result)
  }
}
