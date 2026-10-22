import {
  CONNECTOR_SEARCH_TOOL,
  READ_CONNECTOR_RESULT_TOOL,
  isConnectorTool,
} from './AiAssistModePolicy.mjs'

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

function attributeValue(value) {
  return String(value ?? '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
}

/**
 * Web text is fenced so the model can tell where the page ends and the
 * harness resumes. A page must not be able to close the fence itself.
 */
function webText(text) {
  return String(text ?? '').replace(
    /<(\/?)(web_page|web_results|web_sections)\b/gi,
    '&lt;$1$2'
  )
}

const RECENCY_WORDS = {
  day: 'past day',
  week: 'past week',
  month: 'past month',
  year: 'past year',
}

/** One search result, as the numbered source the model cites it by. */
function sourceLines(entry, index) {
  const number = Number.isInteger(entry.source) ? entry.source : index + 1
  const lines = [`[${number}] ${webText(entry.title)}`, `    ${webText(entry.url)}`]
  if (entry.published) lines.push(`    published ${entry.published}`)
  if (entry.snippet) lines.push(`    ${webText(entry.snippet)}`)
  if (entry.cached)
    lines.push('    read before; web_fetch returns it from the cache')
  return lines
}

function webPageAttributes(result) {
  return [
    Number.isInteger(result.source) ? ` source="${result.source}"` : '',
    ` url="${attributeValue(webText(result.url))}"`,
    result.title ? ` title="${attributeValue(webText(result.title))}"` : '',
    result.published ? ` published="${attributeValue(webText(result.published))}"` : '',
    result.modified ? ` updated="${attributeValue(webText(result.modified))}"` : '',
    result.archived ? ` archived="${attributeValue(webText(result.archived))}"` : '',
    result.partial ? ' partial="true"' : '',
  ].join('')
}

const ARCHIVE_NAMES = {
  wayback: 'the Internet Archive',
  'archive.today': 'archive.today',
}

/** [from, to] ranges as "3, 7–9, 12". */
function rangeText(ranges) {
  return ranges
    .map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`))
    .join(', ')
}

/** 3, 7–9, 12 */
function pageRanges(pages) {
  const ranges = []
  for (const page of pages) {
    const last = ranges[ranges.length - 1]
    if (last && page === last[1] + 1) last[1] = page
    else ranges.push([page, page])
  }
  return rangeText(ranges)
}

/** About how many tokens `chars` characters of page text are. */
function tokenText(chars) {
  const tokens = chars / 4
  if (tokens < 1000) return `~${Math.max(10, Math.round(tokens / 10) * 10)}`
  return `~${tokens < 10_000 ? (tokens / 1000).toFixed(1) : Math.round(tokens / 1000)}k`
}

/** The pages of a document the model has not been shown, or ''. */
function unreadText(result) {
  if (!Number.isInteger(result.unreadCount) || result.unreadCount <= 0) {
    return ''
  }
  const ranges = Array.isArray(result.unreadPages) ? result.unreadPages : []
  const listed = ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0)
  const pages = `${rangeText(ranges)}${listed < result.unreadCount ? ', …' : ''}`
  return `${result.unreadCount === 1 ? 'page' : 'pages'} ${pages}`
}

/**
 * The document's headings with the page each starts on, so the model can
 * jump to a section. They are web text, so they get a fence of their own.
 */
function sectionLines(result) {
  const outline = result.outline
  if (!Array.isArray(outline) || outline.length === 0) return ''
  return [
    `<web_sections${Number.isInteger(result.source) ? ` source="${result.source}"` : ''}>`,
    ...outline.map(
      entry =>
        `${entry.level === 3 ? '  ' : ''}- ${webText(entry.title)} (p. ${entry.page})`
    ),
    '</web_sections>',
  ].join('\n')
}

/** The harness's line above a page: where it sits in the document. */
function pageStatus(result) {
  const { page, totalPages } = result
  if (!Number.isInteger(page) || !Number.isInteger(totalPages)) return ''
  const shown =
    typeof result.content === 'string' ? result.content.length : null
  if (totalPages <= 1) {
    return `[web_fetch] Page 1 of 1: the whole document${shown ? ` (${tokenText(shown)} tokens)` : ''}.`
  }
  const parts = [`[web_fetch] Page ${page} of ${totalPages}`]
  if (shown && Number.isInteger(result.totalChars)) {
    const rest = Math.max(0, result.totalChars - shown)
    parts.push(
      `${tokenText(shown)} tokens shown, ${tokenText(rest)} more on the other ${totalPages - 1} page${totalPages === 2 ? '' : 's'}`
    )
  }
  const unread = unreadText(result)
  if (unread) parts.push(`unread: ${unread}`)
  else if (result.unreadCount === 0) parts.push('every page has now been read')
  if (page < totalPages) parts.push(`next: page=${page + 1}`)
  else parts.push('this is the last page')
  if (result.outline?.length) parts.push('sections and their pages below')
  return `${parts.join(' · ')}.`
}

/** The harness's note after a page: how to get to the rest of it. */
function pageFooter(result) {
  const { page, totalPages } = result
  if (!Number.isInteger(totalPages) || totalPages <= 1) return ''
  const unread = unreadText(result)
  if (result.unreadCount === 0) {
    return `End of page ${page} of ${totalPages}. You have now seen every page of this document.`
  }
  const next = page < totalPages ? `page=${page + 1} for the next page, ` : ''
  const jump = result.outline?.length
    ? 'page=N for the page a section above starts on'
    : 'page=N to jump to any page'
  return `End of page ${page} of ${totalPages}${unread ? `; not yet read: ${unread}` : ''}. If the answer is not above, do not conclude the document lacks it: call web_fetch on this URL with ${next}${jump}, or find="…" to search every page. Independent pages and finds can be fetched in parallel.`
}

/** The harness's line above find results: what matched, and where. */
function findStatus(result) {
  const term = attributeValue(result.find)
  const of = `${result.totalPages} page${result.totalPages === 1 ? '' : 's'}`
  if (result.matches.length === 0) {
    return `[web_fetch] find "${term}": no passage matches on any of the ${of} (the exact phrase, all of its words and most of its words were tried).`
  }
  const where =
    result.totalPages > 1 && result.matchPages?.length
      ? ` on page${result.matchPages.length === 1 ? '' : 's'} ${pageRanges(result.matchPages)} of ${of}`
      : ' in the document'
  const shown =
    result.matches.length < result.totalMatches
      ? `showing the ${result.matches.length} most relevant, in document order`
      : `showing ${result.matches.length === 1 ? 'it' : `all ${result.matches.length}`}`
  const levels = new Set(result.matches.map(match => match.match ?? 'exact'))
  const these = result.matches.length === 1 ? 'this has' : 'these have'
  const closeness = levels.has('exact')
    ? ''
    : levels.has('all words')
      ? ` No passage has the exact phrase; ${these} all of its words.`
      : ` No passage has the exact phrase or all of its words; ${these} most of them, so check ${result.matches.length === 1 ? 'it is' : 'they are'} about the same thing.`
  return `[web_fetch] find "${term}": ${result.totalMatches} passage${result.totalMatches === 1 ? '' : 's'} match${result.totalMatches === 1 ? 'es' : ''}${where}; ${shown}.${closeness}`
}

/** The harness's note after find results: how to see the rest. */
function findFooter(result) {
  const pages = result.totalPages
  if (result.matches.length === 0) {
    const read =
      pages <= 1
        ? 'read the document itself by calling web_fetch without find'
        : result.outline?.length
          ? 'read the page a likely section above starts on with page=N'
          : 'read its pages with page=N'
    return `No match does not prove the document lacks it: it may use other words. Try a shorter phrase, a synonym, alternatives separated by " | ", or ${read}.`
  }
  const lines = []
  const hidden = (result.totalMatches ?? 0) - result.matches.length
  if (hidden > 0) {
    const shownPages = new Set(result.matches.map(match => match.page))
    const elsewhere = (result.matchPages ?? []).filter(
      page => !shownPages.has(page)
    )
    lines.push(
      `${hidden} more matching passage${hidden === 1 ? ' is' : 's are'} not shown${elsewhere.length > 0 ? `, some on page${elsewhere.length === 1 ? '' : 's'} ${pageRanges(elsewhere)}` : ''}. Read a page with page=N to see a passage in full context, or narrow find with more specific words.`
    )
  } else if (pages > 1) {
    lines.push(
      'Each passage is an excerpt; read its page with page=N for the full context.'
    )
  }
  return lines.join(' ')
}

function copyNotes(result) {
  const archive = ARCHIVE_NAMES[result.via] ?? 'the Internet Archive'
  const archived =
    result.archived || result.archiveUrl
      ? result.archived
        ? `The live page could not be read; this is the copy ${archive} captured ${result.archived}. Anything newer than that is not in it.`
        : `The live page could not be read; this is a copy from ${archive}, so it may be out of date.`
      : ''
  const partial = result.partial ? 'Only part of this page could be read.' : ''
  return [archived, partial]
}

const CHOSEN_BY = {
  line: 'the page where the requested line is typeset',
  lastEdit: 'the page of your last edit',
}

/**
 * The text that goes with a rendered PDF page: where the page is, which
 * source lines are at which height, and what to check. The image itself is
 * attached to the message by the run loop, and only while it is among the
 * newest, so this text never claims it is there: it reads the same with the
 * image or without, which keeps a rebuilt transcript byte for byte.
 */
function pdfPageLines(result) {
  const of = result.pageCount ? ` of ${result.pageCount}` : ''
  const size = result.pageSize
    ? `, ${result.pageSize.width}x${result.pageSize.height}pt`
    : ''
  const { focus, span } = result
  let zoom = ''
  if (focus) {
    const range =
      focus.line === focus.endLine
        ? `line ${focus.line}`
        : `lines ${focus.line}-${focus.endLine}`
    zoom = `, zoomed on ${focus.path} ${range} (${span.top}%-${span.bottom}% of the page height)`
  } else if (result.region && result.region !== 'full') {
    zoom = `, ${result.region} third zoomed in (${span.top}%-${span.bottom}% of the page height)`
  }
  // A zoom on source names its lines already, so the reason it was chosen
  // would only repeat them.
  const why =
    focus || !Object.hasOwn(CHOSEN_BY, result.chosenBy)
      ? ''
      : CHOSEN_BY[result.chosenBy]
  const lines = [
    `PDF page ${result.page}${of}${size}${zoom}${why ? `: ${why}` : ''}.`,
  ]
  if (result.imageOmitted) {
    lines.push(
      result.text
        ? 'This model cannot take images, so the page is described only by the page text, the SyncTeX map and bad boxes below.'
        : 'This model cannot take images, so the page is described only by the SyncTeX map and bad boxes below.'
    )
  }
  if (focus?.continuesOn?.length) {
    lines.push(
      `The block continues on ${focus.continuesOn.length === 1 ? 'page' : 'pages'} ${pageRanges(focus.continuesOn)}.`
    )
  }
  if (result.located) {
    lines.push(
      `${result.located.path} line ${result.located.line} is typeset about ${result.located.y}% down the page.`
    )
  }
  if (result.note) lines.push(result.note)
  if (Array.isArray(result.blocks) && result.blocks.length > 0) {
    lines.push('Labelled blocks on this page (label, height from the top, source):')
    lines.push(
      ...result.blocks.map(block => {
        const range =
          block.endLine && block.endLine !== block.line
            ? `${block.line}-${block.endLine}`
            : `${block.line}`
        const text = block.text ? `  ${oneLine(block.text, 60)}` : ''
        return `  ${block.id}  ${Math.round(block.bbox?.y ?? 0)}pt  ${block.path}:${range}${text}`
      })
    )
    lines.push(
      'Pass the label as block with this page to resolve_pdf_block, or open the lines with path and line.'
    )
  }
  if (Array.isArray(result.defects) && result.defects.length > 0) {
    lines.push('Defects on this page (fix the cause in the source):')
    for (const defect of result.defects) {
      const where = defect.path
        ? `${defect.path}${defect.line ? `:${defect.line}` : ''}`
        : 'unknown source'
      lines.push(
        `  ${defect.id} ${defect.severity} ${defect.category}  ${where}  ${oneLine(defect.evidence, 160)}`
      )
      if (defect.bannedFixes?.length) {
        lines.push(`      do not use: ${defect.bannedFixes.join(', ')}`)
      }
    }
  }
  if (result.sourceStatus && result.sourceStatus !== 'mapped') {
    lines.push(sourceStatusText(result))
  }
  lines.push(...buildStaleLines(result))
  if (result.stale) {
    lines.push(
      'You edited the project after this build, so the page does not show those edits yet. Call compile_project, then view it again.'
    )
  }
  if (result.sourceMap?.length) {
    lines.push('SyncTeX map (height on the page -> source):')
    lines.push(
      ...result.sourceMap.map(
        row => `  ${String(row.y).padStart(3)}%  ${row.path}:${row.line}`
      )
    )
  } else {
    lines.push(
      'SyncTeX found no source on this page (it may be blank, or only images).'
    )
  }
  if (result.badBoxes?.length) {
    lines.push('Overfull/underfull boxes on this page:')
    lines.push(
      ...result.badBoxes.map(box => {
        const where = box.path
          ? `${box.path}${box.line ? `:${box.line}` : ''}`
          : 'unknown source'
        return `  ${where}  ${box.message}`
      })
    )
  }
  if (result.text) {
    lines.push('Page text (height % from the top):')
    const rows = Array.isArray(result.text.lines) ? result.text.lines : []
    if (rows.length > 0) {
      lines.push(
        ...rows.map(row => `  ${String(row.y).padStart(3)}%  ${row.text}`)
      )
    } else {
      lines.push('  (no text on this page; it may be only images)')
    }
    if (result.text.truncated) {
      lines.push('(more text on this page is not shown)')
    }
  }
  lines.push(
    'Check for content past the margins, overlaps, misplaced floats, ?? or [?], missing symbols and bad breaks. Fix at the source line nearest the problem, compile_project, then view the page again.'
  )
  // Zooming needs the picture, so a model that cannot see it is not told to.
  if (!focus && !result.imageOmitted) {
    lines.push(
      'To check one element closely, pass path, line and endLine.'
    )
  }
  if (!result.imageOmitted) {
    lines.push(
      'Only the newest page images stay in the conversation; if this page has no image with it, call view_compiled_pdf_page again to see it.'
    )
  }
  return lines
}

/**
 * The build's staleness by fingerprint (BuildFingerprint.mjs): the PDF was
 * made from other inputs than the project now has. Says why and which files,
 * and what to run. Empty when the build matches the project.
 */
function buildStaleLines(result) {
  const stale = result.buildStale
  if (!stale) return []
  const why = {
    docs_changed: 'project files changed since this build',
    compiler_changed: 'the compiler or TeX image changed since this build',
    root_changed: 'the root document changed since this build',
  }[stale.reason] ?? 'the project changed since this build'
  const changed =
    Array.isArray(stale.changed) && stale.changed.length > 0
      ? ` Changed: ${stale.changed.join(', ')}.`
      : ''
  const clean = stale.reason === 'compiler_changed' ? ' with clean set to true' : ''
  return [
    `The PDF is out of date: ${why}.${changed} It shows the earlier source, whoever made the change. Call compile_project${clean}, then view it again.`,
  ]
}

/**
 * What the inspector could not match to source, and what the model should do
 * about it. The reasons are the inspector's sourceStatus values.
 */
function sourceStatusText(result) {
  const where = result.focus
    ? `${result.focus.path}:${result.focus.line}`
    : result.path
      ? result.path
      : 'the line'
  switch (result.sourceStatus) {
    case 'no_synctex':
      return 'No SyncTeX data came with this build, so the page cannot be tied to source. Call compile_project with clean set to true, then view the page again.'
    case 'probe_missed':
      return 'SyncTeX did not find the source on this page for the line asked about. Pass path and line again (with endLine for a block) to zoom on it.'
    case 'line_not_in_build':
      return `${where} is not typeset in this build. It is outside the \\input'd or compiled content, or behind \\iffalse or a comment environment: check where that file is included.`
    case 'page_without_source':
      return 'This page has no source of its own; its content comes from earlier pages or from floats placed here.'
    default:
      return result.sourceNote || ''
  }
}

/** "page 3" or "pages 1-12". */
function pageSpanText(from, to) {
  return from === to ? `page ${from}` : `pages ${from}-${to}`
}

/** One line of text, cut short so a single match cannot fill the result. */
function oneLine(text, max = 200) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Up to eight names, then how many more there are. */
function nameList(names, max = 8) {
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown}, and ${names.length - max} more` : shown
}

/** "Letter portrait (612x792pt)", without what is not known. */
function paperText(paper) {
  if (!paper || typeof paper.width !== 'number') return ''
  const name = paper.name ? `${paper.name} ` : ''
  const orientation = paper.orientation ? `${paper.orientation} ` : ''
  return `${name}${orientation}(${paper.width}x${paper.height}pt)`
}

/** The fonts that print badly, or '' when every font is embedded and vector. */
function fontsText(fonts) {
  const notEmbedded = Array.isArray(fonts?.notEmbedded) ? fonts.notEmbedded : []
  const type3 = Array.isArray(fonts?.type3) ? fonts.type3 : []
  const parts = []
  if (notEmbedded.length > 0) {
    parts.push(`not embedded: ${nameList(notEmbedded)}.`)
  }
  if (type3.length > 0) {
    parts.push(
      `Bitmap Type 3 (blurry text; usually fixed with \\usepackage[T1]{fontenc} and lmodern or cm-super): ${nameList(type3)}.`
    )
  }
  return parts.length > 0 ? `Fonts: ${parts.join(' ')}` : ''
}

function sourceRangeText(range) {
  const lines =
    range.startLine === range.endLine
      ? `${range.startLine}`
      : `${range.startLine}-${range.endLine}`
  return `${range.path}:${lines}`
}

/** What measuring one overview page found, one short clause each. */
function overviewPageProblems(page) {
  const problems = []
  if (page.badBoxes > 0) {
    const count = `${page.badBoxes} bad box${page.badBoxes === 1 ? '' : 'es'}`
    const worst = page.worstBadBox
    if (worst) {
      const where = worst.path
        ? `${worst.path}${worst.line ? `:${worst.line}` : ''}`
        : 'an unknown source'
      problems.push(`${count}, worst ${where} ${worst.message}`)
    } else {
      problems.push(count)
    }
  }
  if (typeof page.endsAt === 'number') {
    problems.push(`content ends ${page.endsAt}% down`)
  }
  const gaps = Array.isArray(page.gaps) ? page.gaps : []
  if (gaps.length > 0) {
    const bands = gaps.map(gap => `${gap.top}%-${gap.bottom}%`).join(', ')
    problems.push(`empty ${gaps.length === 1 ? 'band' : 'bands'} ${bands}`)
  }
  for (const overflow of Array.isArray(page.overflow) ? page.overflow : []) {
    const mm = Math.round(overflow.mm * 10) / 10
    problems.push(
      `ink ${mm}mm past the ${overflow.side} edge of the text block at ${overflow.top}%-${overflow.bottom}% down`
    )
  }
  const refs = page.unresolved?.refs ?? 0
  const cites = page.unresolved?.cites ?? 0
  if (refs > 0) problems.push(`${refs}x ?? (undefined \\ref)`)
  if (cites > 0) problems.push(`${cites}x [?] (undefined \\cite)`)
  return problems
}

/**
 * The overview: what the image shows, what measuring the pages found, and
 * where the next pages are. Thumbnails cannot show small text, so the text
 * says to open a page for that.
 */
function pdfOverviewLines(result) {
  const to = result.toPage ?? result.fromPage + result.pages.length - 1
  const paper = paperText(result.paper)
  const head = `PDF overview: ${pageSpanText(result.fromPage, to)} of ${result.pageCount}${paper ? `, ${paper}` : ''}.`
  const picture = result.imageOmitted
    ? 'This model cannot take images, so only the measured facts are listed.'
    : result.image
      ? `The image shows them ${result.columns ? `${result.columns} per row` : 'as thumbnails'}, each labelled with its page number.`
      : ''
  const lines = [[head, picture].filter(Boolean).join(' ')]
  lines.push(...buildStaleLines(result))
  if (result.stale) {
    lines.push(
      'You edited the project after this build, so the thumbnails do not show those edits yet. Call compile_project, then view again.'
    )
  }
  if (result.mixedSizes) {
    lines.push('The pages in this range have different sizes.')
  }
  const fonts = fontsText(result.fonts)
  if (fonts) lines.push(fonts)
  for (const page of result.pages) {
    const problems = page.blank ? [] : overviewPageProblems(page)
    lines.push(
      `  ${`p${page.page}`.padEnd(4)} ${[pageSourceText(page), ...problems].join(' | ')}`
    )
  }
  const hint =
    'Thumbnails cannot show small details: open a page with view_compiled_pdf_page to check it.'
  if (result.pageCount > to) {
    const rest =
      to + 1 === result.pageCount
        ? `Page ${result.pageCount}`
        : `Pages ${to + 1}-${result.pageCount}`
    lines.push(`${hint} ${rest}: call again with fromPage ${to + 1}.`)
  } else {
    lines.push(hint)
  }
  return lines
}

/** Where a page's source is, or what it is when there is none to show. */
function pageSourceText(page) {
  if (page.blank) return 'blank'
  const ranges = Array.isArray(page.source) ? page.source : []
  return ranges.length > 0
    ? ranges.map(sourceRangeText).join(', ')
    : 'no source found'
}

function searchMatchLine(match) {
  let source = '(no source found)'
  if (match.path) {
    source = match.line ? `${match.path}:${match.line}` : match.path
  }
  const percent = typeof match.y === 'number' ? `${Math.round(match.y)}%` : '?%'
  const snippet = oneLine(match.context || match.text)
  return `  ${`p${match.page}`.padEnd(4)} ${percent}  ${source}${snippet ? `  …${snippet}…` : ''}`
}

/** The search: its matches with their pages, or the reason there are none. */
function pdfSearchLines(result) {
  const lines = []
  lines.push(...buildStaleLines(result))
  if (result.stale) {
    lines.push(
      'You edited the project after this build, so the PDF does not show those edits yet. Call compile_project, then search again.'
    )
  }
  if (result.matchCount === 0) {
    const scope = Number.isInteger(result.fromPage) && Number.isInteger(result.toPage)
      ? `${pageSpanText(result.fromPage, result.toPage)} of the PDF`
      : 'the PDF'
    lines.push(
      `No match for "${result.query}" in ${scope}. The text may be typeset differently (try fewer words), be inside an image, or not be in this build.`
    )
    return lines
  }
  const onPages =
    result.pages.length > 0
      ? ` on ${result.pages.length === 1 ? 'page' : 'pages'} ${pageRanges(result.pages)}`
      : ''
  const shown = result.truncated ? ` (first ${result.matches.length} shown)` : ''
  lines.push(
    `${result.matchCount} ${result.matchCount === 1 ? 'match' : 'matches'} for "${result.query}"${onPages}${shown}:`
  )
  lines.push(...result.matches.map(searchMatchLine))
  lines.push(
    'Open a page with view_compiled_pdf_page (page, or path and line) to see a match in place.'
  )
  return lines
}

const RENDERERS = {
  web_search(result) {
    if (!Array.isArray(result.results)) return JSON.stringify(result)
    const filters = [
      result.recency ? RECENCY_WORDS[result.recency] : '',
      result.topic === 'news' ? 'news' : '',
    ].filter(Boolean)
    const lines = [
      `<web_results query="${attributeValue(result.query)}"${filters.length ? ` filter="${filters.join(', ')}"` : ''}>`,
    ]
    if (result.relaxed) {
      lines.push(
        'Nothing matched the filter, so these results are from an unfiltered search.'
      )
    }
    for (const answer of result.answers ?? []) {
      lines.push(`Answer: ${webText(answer)}`)
    }
    if (result.results.length === 0) {
      lines.push('No results. Try fewer or different words.')
    }
    result.results.forEach((entry, index) =>
      lines.push(...sourceLines(entry, index))
    )
    lines.push('</web_results>')
    return lines.join('\n')
  },

  // The status line comes first, where it cannot be missed, and the note
  // after the page says how to read on: a model that is not told a page is
  // one of several takes it for the whole document.
  web_fetch(result) {
    const open = `<web_page${webPageAttributes(result)}>`
    const truncated = result.truncated
      ? 'The document was cut short because it is very large.'
      : ''

    if (Array.isArray(result.matches)) {
      const body =
        result.matches.length === 0
          ? '(no matching passages)'
          : result.matches
              .map(
                match =>
                  `[page ${match.page}]${match.heading ? ` ${webText(match.heading)}` : ''}${match.match ? ` (${match.match})` : ''}\n${webText(match.text)}`
              )
              .join('\n\n')
      return [
        findStatus(result),
        sectionLines(result),
        open,
        body,
        '</web_page>',
        findFooter(result),
        truncated,
        ...copyNotes(result),
      ]
        .filter(Boolean)
        .join('\n')
    }

    return [
      pageStatus(result),
      sectionLines(result),
      open,
      webText(result.content),
      '</web_page>',
      pageFooter(result),
      truncated,
      ...copyNotes(result),
    ]
      .filter(Boolean)
      .join('\n')
  },

  compile_project(result) {
    if (typeof result.errorCount !== 'number') return JSON.stringify(result)
    const lines = [
      result.message ||
        `Compile ${result.status}: ${result.errorCount} error(s), ${result.warningCount} warning(s).`,
    ]
    if (result.errorCount > 1)
      lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    const hiddenErrors = result.errorCount - (result.errors?.length ?? 0)
    const hiddenWarnings =
      (result.warningCount ?? 0) - (result.warnings?.length ?? 0)
    if (hiddenErrors > 0 || hiddenWarnings > 0) {
      lines.push(
        `(${hiddenErrors} more error(s) and ${hiddenWarnings} more warning(s) not shown; call get_compile_result with a higher limit)`
      )
    }
    if (result.visualCheck) lines.push(result.visualCheck)
    return lines.join('\n')
  },

  view_compiled_pdf_page(result) {
    if (typeof result.page !== 'number') return JSON.stringify(result)
    return pdfPageLines(result).join('\n')
  },

  resolve_pdf_block(result) {
    if (!result.block || typeof result.line !== 'number') {
      return JSON.stringify(result)
    }
    const range =
      result.endLine && result.endLine !== result.line
        ? `lines ${result.line}-${result.endLine}`
        : `line ${result.line}`
    return `Block ${result.block} on page ${result.page} is ${result.path} ${range}.`
  },

  diff_compiled_pdf(result) {
    if (!Array.isArray(result.summary)) return JSON.stringify(result)
    const lines = [
      result.changed
        ? 'Compared with the build before the last compile:'
        : 'No visible change from the build before the last compile.',
      ...result.summary.map(text => `  ${text}`),
    ]
    if (result.truncated) {
      lines.push('(more pages changed; pass pages to see the rest)')
    }
    if (result.image) {
      lines.push(
        'The picture shows the changed regions of the new build, boxed; the rest is as it was.'
      )
    }
    return lines.join('\n')
  },

  inspect_compiled_style(result) {
    if (!result?.style) return JSON.stringify(result)
    const s = result.style
    const lines = []
    lines.push(`Compiled style: ${s.paper || 'unknown paper'}, ${s.class || 'unknown class'}, ${s.pages ?? '?'} page(s).`)
    if (s.area) {
      const w = s.area.w?.v ?? s.area.w
      const h = s.area.h?.v ?? s.area.h
      const cols = s.area.cols ? `, ${s.area.cols} col(s)` : ''
      lines.push(`  Text area: ${w}x${h}pt${cols} (margins: left ${s.area.left?.v ?? '?'}, right ${s.area.right?.v ?? '?'}, top ${s.area.top?.v ?? '?'}, bottom ${s.area.bottom?.v ?? '?'}pt)`)
    }
    if (s.body) {
      const size = s.body.size?.v ?? s.body.size
      const font = s.body.font?.name || s.body.font?.family || 'default'
      const base = s.body.baseline?.v ?? s.body.baseline
      lines.push(`  Body: ${size}pt ${font}, baseline ${base}pt`)
    }
    if (result.diff) {
      const d = result.diff
      lines.push(`Style comparison: ${d.same} property(ies) match, ${d.diffs?.length ?? 0} differ.`)
      for (const diff of d.diffs || []) {
        lines.push(`  ${diff.prop}: current ${diff.now}, target ${diff.template}${diff.fix ? ` (fix: ${diff.fix})` : ''}`)
      }
    }
    return lines.join('\n')
  },

  view_compiled_pdf_overview(result) {
    if (!Array.isArray(result.pages) || typeof result.pageCount !== 'number') {
      return JSON.stringify(result)
    }
    return pdfOverviewLines(result).join('\n')
  },

  search_compiled_pdf(result) {
    if (!Array.isArray(result.matches) || typeof result.matchCount !== 'number') {
      return JSON.stringify(result)
    }
    return pdfSearchLines(result).join('\n')
  },

  // The boxes themselves go to the viewer, not the model: their coordinates
  // would cost tokens and tell it nothing it can act on
  highlight_in_pdf(result) {
    if (typeof result.count !== 'number' || !Array.isArray(result.pages)) {
      return JSON.stringify(result)
    }
    const where =
      result.pages.length > 0
        ? ` on ${result.pages.length === 1 ? 'page' : 'pages'} ${pageRanges(result.pages)}`
        : ''
    const lines = [
      `Highlighted ${result.count} area(s)${where} in the user's PDF viewer. The project is unchanged.`,
    ]
    if (result.stale) {
      lines.push(
        'You edited the project after this build, so the highlight may be off. Call compile_project to refresh the PDF.'
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
    if (result.errorCount > 1)
      lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    if (result.truncated)
      lines.push('(more entries not shown; pass a higher limit)')
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
    return result.excerpt
      ? [header, '```', result.excerpt, '```'].join('\n')
      : header
  },

  get_outline(result) {
    if (result.sections && result.range) {
      const toStr =
        result.range.to === Number.MAX_SAFE_INTEGER ? 'end' : result.range.to
      return [
        `section lines ${result.range.from}-${toStr}`,
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
          i =>
            `\\input ${i.from}:${i.line} -> ${i.to}${i.resolved ? '' : ' (UNRESOLVED)'}`
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
      lines.push(
        ...result.labels.map(l => `label ${l.key}  ${l.path}:${l.line}`)
      )
      lines.push(
        ...(result.duplicateLabels ?? []).map(k => `DUPLICATE label ${k}`)
      )
    }
    if (result.refs) {
      lines.push(
        ...result.refs.map(
          r =>
            `${r.command} ${r.key}  ${r.path}:${r.line}  ${r.resolved ? 'ok' : 'UNRESOLVED'}`
        )
      )
    }
    if (result.citations) {
      lines.push(
        ...result.citations.map(
          c =>
            `${c.command} ${c.key}  ${c.path}:${c.line}  ${c.resolved ? 'ok' : 'MISSING'}`
        )
      )
    }
    if (result.bibKeys) {
      lines.push(
        ...result.bibKeys.map(b => `bib ${b.key}  ${b.path}:${b.line}`)
      )
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
      rows.push(
        `(${result.total - result.files.length} more; narrow with glob=)`
      )
    }
    return rows.length > 0 ? rows.join('\n') : '(no files found)'
  },

  read_file(result) {
    if (result.totalLines === 0) {
      return `${result.path} is empty (0 lines)\n\`\`\`\n\`\`\``
    }
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
          lines.push(
            ...hit.before.map(
              (l, i) => `  ${hit.line - hit.before.length + i}: ${l}`
            )
          )
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

  create_file(result) {
    if (result.status !== 'applied') return JSON.stringify(result)
    return `Created file ${result.path}.`
  },

  list_available_settings(result) {
    if (!result?.options) return JSON.stringify(result)
    const o = result.options
    const themeNames = Array.isArray(o.editorThemes)
      ? o.editorThemes.map(t => (typeof t === 'string' ? t : t.name))
      : []
    const fontNames = Array.isArray(o.fontFamilies)
      ? o.fontFamilies.map(f =>
          typeof f === 'string' ? f : `${f.name} (${f.label})`
        )
      : []
    const lines = [
      'Available Settings & Options:',
      `Compilers: ${(o.compilers || []).join(', ')}`,
      `TeX Live Versions: ${(o.imageNames || []).map(img => img.imageName || img).join(', ')}`,
      `Keybinding Modes: ${(o.editorModes || []).join(', ')}`,
      `Overall Themes: ${(o.overallThemes || []).join(', ')}`,
      themeNames.length > 0 ? `Editor Themes: ${themeNames.join(', ')}` : '',
      fontNames.length > 0 ? `Code Fonts: ${fontNames.join(', ')}` : '',
      `Line Heights: ${(o.lineHeights || []).join(', ')}`,
      `Spellcheck Languages: ${(o.spellCheckLanguages || [])
        .slice(0, 10)
        .map(l => `${l.code} (${l.name})`)
        .join(', ')}${(o.spellCheckLanguages || []).length > 10 ? '...' : ''}`,
      `PDF Viewers: ${(o.pdfViewers || ['pdfjs', 'native']).join(', ')}`,
    ].filter(Boolean)
    return lines.join('\n')
  },

  get_project_settings(result) {
    if (!result?.settings) return JSON.stringify(result)
    const { compiler, appearance, editor, spelling, name, description } =
      result.settings
    const lines = ['Current Project Settings:']
    if (name)
      lines.push(`Project: ${name}${description ? ` - ${description}` : ''}`)
    if (compiler) {
      lines.push(
        `Compiler: ${compiler.compiler || 'pdflatex'}, TeX Live: ${compiler.imageName || 'default'}, Root Doc: ${compiler.rootDocPath || compiler.rootDocId || '(none)'}${compiler.draft ? ', Draft: on' : ''}${compiler.stopOnFirstError ? ', Stop on Error: on' : ''}`
      )
    }
    if (appearance) {
      lines.push(
        `Appearance: Theme=${appearance.editorTheme || 'textmate'} (UI: ${appearance.overallTheme || 'system'}), Font Size=${appearance.fontSize ?? 12}px${appearance.fontFamily ? `, Font=${appearance.fontFamily}` : ''}${appearance.lineHeight ? `, Line Height=${appearance.lineHeight}` : ''}${appearance.darkModePdf ? ', Dark PDF: on' : ''}`
      )
    }
    if (editor) {
      lines.push(
        `Editor: Keybindings=${editor.mode || 'none'}, Auto-complete=${editor.autoComplete ? 'on' : 'off'}, Auto-close brackets=${editor.autoPairDelimiters ? 'on' : 'off'}, Syntax validation=${editor.syntaxValidation ? 'on' : 'off'}, PDF viewer=${editor.pdfViewer || 'pdfjs'}, Math preview=${editor.mathPreview ? 'on' : 'off'}, Breadcrumbs=${editor.breadcrumbs ? 'on' : 'off'}, Tabs=${editor.editorTabs ? 'on' : 'off'}`
      )
    }
    if (spelling?.spellCheckLanguage) {
      lines.push(`Spellcheck: ${spelling.spellCheckLanguage}`)
    }
    return lines.join('\n')
  },

  configure_appearance_settings(result) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated appearance settings (${keys.join(', ')}): ${result.message || 'applied successfully.'}`
    }
    return JSON.stringify(result)
  },

  configure_editor_settings(result) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated editor settings (${keys.join(', ')}): ${result.message || 'applied successfully.'}`
    }
    return JSON.stringify(result)
  },

  configure_compiler_settings(result) {
    if (result?.error) return JSON.stringify(result)
    if (result?.updatedSettings) {
      const keys = Object.keys(result.updatedSettings)
      return `Updated compiler settings (${keys.join(', ')}): ${result.message || 'applied successfully.'}`
    }
    return JSON.stringify(result)
  },

  present_plan(result) {
    if (result?.message) return result.message
    return JSON.stringify(result)
  },
}

RENDERERS.search_project = RENDERERS.search_text
RENDERERS.project_map = RENDERERS.list_files
RENDERERS.get_compile_log = RENDERERS.get_compile_result

/**
 * A page that could not be read, with what its search result said about it.
 * The snippet is still web text, so it stays inside the fence.
 */
function renderFetchFailure(result) {
  return [
    `Error: ${result.error}`,
    '<web_results>',
    ...sourceLines(result, 0),
    '</web_results>',
  ].join('\n')
}

/** Adds a harness note for the model to a tool result, after any it has. */
export function withNotice(result, notice) {
  if (!notice || !result || typeof result !== 'object' || Array.isArray(result))
    return result
  return {
    ...result,
    notice: result.notice ? `${result.notice} ${notice}` : notice,
  }
}

export function renderToolResult(name, result) {
  // A notice is the harness talking, not the tool: it goes after the result,
  // and lives in the result object so a rebuilt transcript renders the same.
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    typeof result.notice === 'string' &&
    result.notice
  ) {
    const { notice, ...rest } = result
    return `${renderToolResult(name, rest)}\n\n${notice}`
  }
  if (name === 'web_fetch' && result?.error && result.snippet && result.url) {
    return renderFetchFailure(result)
  }
  // Connector calls, and the two tools that load or page through their results
  if (
    isConnectorTool(name) ||
    name === CONNECTOR_SEARCH_TOOL ||
    name === READ_CONNECTOR_RESULT_TOOL
  ) {
    if (result === null || result === undefined) return ''
    if (typeof result === 'string') return result
    // An MCP error and a harness error both read as "Error: ...", so a
    // provider without an is_error flag still sees the call failed
    if (result.error) return `Error: ${result.error}`
    if (result.result !== undefined) {
      return typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result)
    }
    if (result.content !== undefined) {
      return typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content)
    }
    return JSON.stringify(result)
  }
  const renderer = Object.hasOwn(RENDERERS, name) ? RENDERERS[name] : undefined
  if (
    !renderer ||
    result === null ||
    typeof result !== 'object' ||
    result.error
  ) {
    return JSON.stringify(result)
  }
  try {
    return renderer(result)
  } catch {
    return JSON.stringify(result)
  }
}

/**
 * A connector result its server flagged as an error is a failed call. It is
 * recorded as an error, so every provider sees the failure in the text (not
 * only in is_error, which OpenAI and Gemini do not have) and the run counts it
 * as failed.
 */
export function connectorOutcome(result) {
  if (!result || typeof result !== 'object') return result
  if (result.error || result.isError !== true) return result
  const rest = { ...result }
  delete rest.isError
  delete rest.result
  const body = result.result
  let message
  if (typeof body === 'string' && body) message = body
  else if (body === undefined || body === null || body === '') {
    message = 'The tool reported an error.'
  } else message = JSON.stringify(body)
  return { ...rest, error: message, mcpError: true }
}
