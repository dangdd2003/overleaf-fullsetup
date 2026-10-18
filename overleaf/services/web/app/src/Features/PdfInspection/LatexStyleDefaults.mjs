// Document class defaults and the map from a measured property to the LaTeX
// setting that controls it, for PdfStyleInspector. Lengths are TeX points.
//
// The numbers for article, report, book and amsart were read from a probe
// document compiled with the TeX Live in the dev image: \the\textwidth and
// friends, the font sizes of each sectioning command, and the spacing
// arguments of \@startsection. Spacing arguments are in ex, converted with the
// body font's ex. Only the stretch-free part is kept. IEEEtran, llncs and
// revtex are not installed in that image, so they are listed without numbers
// and the inspector reports their defaults as unknown.

// Letter paper, the default for these classes when no paper option is given.
export const DEFAULT_PAPER = { name: 'Letter', wPt: 614.295, hPt: 794.97 }

const sizes = (body, bl, extra = {}) => ({
  body: [body, bl],
  ...extra,
})

// Sizes are [font size, baselineskip] in pt. Heading spacing: before is the
// space above, after the space below, both as the \@startsection skips read.
const ARTICLE_SIZES = {
  10: sizes(10, 12, {
    small: [9, 11],
    footnotesize: [8, 9.5],
    large: [12, 14],
    Large: [14.4, 18],
    LARGE: [17.28, 22],
    huge: [20.74, 25],
  }),
  11: sizes(10.95, 13.6, {
    small: [10, 12],
    footnotesize: [9, 11],
    large: [12, 14],
    Large: [14.4, 18],
    LARGE: [17.28, 22],
    huge: [20.74, 25],
  }),
  12: sizes(12, 14.5, {
    small: [10.95, 13.6],
    footnotesize: [10, 12],
    large: [14.4, 18],
    Large: [17.28, 22],
    LARGE: [20.74, 25],
    huge: [24.88, 30],
  }),
}

function article(size, extra) {
  const base = ARTICLE_SIZES[size]
  return {
    bodySizePt: base.body[0],
    baselinePt: base.body[1],
    sizes: { ...base, ...extra?.sizes },
    textwidthPt: { 10: 345, 11: 360, 12: 390 }[size],
    textheightPt: { 10: 550, 11: 541.4, 12: 548.5 }[size],
    oddsidemarginPt: { 10: 62, 11: 54, 12: 39 }[size],
    topmarginPt: { 10: 16, 11: 21, 12: 17 }[size],
    headheightPt: 12,
    headsepPt: 25,
    footskipPt: 30,
    marginparwidthPt: { 10: 65, 11: 59, 12: 44 }[size],
    columnsepPt: 10,
    parindentPt: { 10: 15, 11: 17, 12: 17.62 }[size],
    parskipPt: 0,
    headings: {
      section: {
        size: { 10: 14.4, 11: 14.4, 12: 17.28 }[size],
        before: { 10: 15.07, 11: 16.5, 12: 18.08 }[size],
        after: { 10: 9.9, 11: 10.84, 12: 11.88 }[size],
      },
      subsection: {
        size: { 10: 12, 11: 12, 12: 14.4 }[size],
        before: { 10: 14.0, 11: 15.3, 12: 16.79 }[size],
        after: { 10: 6.46, 11: 7.07, 12: 7.75 }[size],
      },
      subsubsection: {
        size: { 10: 10, 11: 10.95, 12: 12 }[size],
        before: { 10: 14.0, 11: 15.3, 12: 16.79 }[size],
        after: { 10: 6.46, 11: 7.07, 12: 7.75 }[size],
      },
    },
    caption: { size: base.body[0], baselinePt: base.body[1] },
    footnote: { size: base.footnotesize[0], baselinePt: base.footnotesize[1] },
    ...extra,
  }
}

// report has the article geometry. book is twoside, so its oddsidemargin is
// the odd-page value.
const ARTICLE = {
  10: article(10),
  11: article(11),
  12: article(12),
}

const REPORT = ARTICLE

const BOOK = {
  10: article(10, { oddsidemarginPt: 35, topmarginPt: 22, headsepPt: 18.07, footskipPt: 25.29, marginparwidthPt: 125 }),
  11: article(11, { oddsidemarginPt: 29, topmarginPt: 24, headsepPt: 19.87, footskipPt: 27.46, marginparwidthPt: 116 }),
  12: article(12, { oddsidemarginPt: 17, topmarginPt: 20, headsepPt: 19.87, footskipPt: 30, marginparwidthPt: 98 }),
}

// amsart: sections are small caps, spaced in multiples of \linespacing, which
// the probe read as 12pt at 10pt size, so spacing is kept as measured sizes only.
const AMSART = {
  10: article(10, {
    textwidthPt: 360,
    textheightPt: 584,
    oddsidemarginPt: 54.88,
    topmarginPt: 22.22,
    headheightPt: 8,
    headsepPt: 14,
    footskipPt: 12,
    marginparwidthPt: 90,
    parindentPt: 12,
    headings: {
      section: { size: 10, before: 8.4, after: 6, approx: true },
      subsection: { size: 10, before: 6, after: -5, approx: true },
    },
    footnote: { size: 8, baselinePt: 10 },
  }),
  11: article(11, {
    textwidthPt: 360,
    textheightPt: 584,
    oddsidemarginPt: 54.88,
    topmarginPt: 22.22,
    headheightPt: 8,
    headsepPt: 14,
    footskipPt: 12,
    marginparwidthPt: 90,
    parindentPt: 12,
    baselinePt: 13,
    bodySizePt: 10.95,
    sizes: { body: [10.95, 13] },
    headings: {
      section: { size: 10.95, before: 9.6, after: 6.7, approx: true },
    },
    footnote: { size: 9, baselinePt: 11 },
  }),
  12: article(12, {
    textwidthPt: 360,
    textheightPt: 584,
    oddsidemarginPt: 54.88,
    topmarginPt: 22.22,
    headheightPt: 8,
    headsepPt: 14,
    footskipPt: 12,
    marginparwidthPt: 90,
    parindentPt: 12,
    baselinePt: 14,
    bodySizePt: 12,
    sizes: { body: [12, 14] },
    headings: {
      section: { size: 12, before: 9.8, after: 7.2, approx: true },
    },
    footnote: { size: 10, baselinePt: 12 },
  }),
}

// Classes known here by name. A class missing from this table, or a size
// missing from its entry, has no defaults: the inspector reports those values
// as measured only.
export const CLASS_DEFAULTS = {
  article: ARTICLE,
  report: REPORT,
  book: BOOK,
  amsart: AMSART,
}

// Classes that exist in some TeX installs but have no measured defaults here.
export const UNMEASURED_CLASSES = ['IEEEtran', 'llncs', 'revtex4', 'revtex4-1', 'revtex4-2', 'svjour3', 'elsarticle', 'acmart']

/**
 * The defaults for a class at a size ('10pt', 11 or '11'), or null. The size
 * is clamped to the nearest one the table holds.
 */
export function classDefaults(className, sizePt) {
  const table = CLASS_DEFAULTS[String(className || '').toLowerCase()]
  if (!table) return null
  const wanted = Number.parseFloat(String(sizePt ?? 10))
  const size = [10, 11, 12].reduce((best, s) =>
    Math.abs(s - (Number.isFinite(wanted) ? wanted : 10)) < Math.abs(best - (Number.isFinite(wanted) ? wanted : 10)) ? s : best
  , 10)
  return table[size] ?? null
}

/**
 * Property key (as PdfStyleInspector names it) to the LaTeX setting that
 * changes it. `template` is filled with the target value, in pt unless the
 * template says otherwise.
 */
export const PROPERTY_SETTINGS = {
  'area.width': { setting: '\\usepackage[textwidth=<value>]{geometry}', alt: '\\setlength{\\textwidth}{<value>}', unit: 'pt' },
  'area.height': { setting: '\\usepackage[textheight=<value>]{geometry}', alt: '\\setlength{\\textheight}{<value>}', unit: 'pt' },
  'area.left': { setting: '\\usepackage[left=<value>]{geometry}', unit: 'pt' },
  'area.right': { setting: '\\usepackage[right=<value>]{geometry}', unit: 'pt' },
  'area.top': { setting: '\\usepackage[top=<value>]{geometry}', unit: 'pt' },
  'area.bottom': { setting: '\\usepackage[bottom=<value>]{geometry}', unit: 'pt' },
  'area.columns': { setting: '\\documentclass[twocolumn]{<class>}  or  \\twocolumn', unit: 'count' },
  'area.columnGap': { setting: '\\usepackage[columnsep=<value>]{geometry}', alt: '\\setlength{\\columnsep}{<value>}', unit: 'pt' },
  baselinePt: { setting: '\\linespread{<ratio>}  or  \\usepackage{setspace} + \\setstretch{<ratio>}', alt: '\\setlength{\\baselineskip}{<value>}', unit: 'pt' },
  parIndentPt: { setting: '\\setlength{\\parindent}{<value>}', unit: 'pt' },
  parSkipPt: { setting: '\\setlength{\\parskip}{<value>}  or  \\usepackage{parskip}', unit: 'pt' },
  'fonts.body.sizePt': { setting: '\\documentclass[<size>pt]{<class>}', unit: 'pt' },
  'fonts.headings.section.sizePt': { setting: '\\titleformat{\\section}{\\<size>\\bfseries}{\\thesection}{1em}{}  (titlesec) or redefine \\section', unit: 'pt' },
  'fonts.headings.subsection.sizePt': { setting: '\\titleformat{\\subsection}{\\<size>\\bfseries}{\\thesubsection}{1em}{}  (titlesec) or redefine \\subsection', unit: 'pt' },
  'fonts.body.family': { setting: '\\usepackage{<font>}  (times, mathptmx, newtxtext, palatino, lmodern, fontspec...)', unit: 'text' },
  'fonts.caption.sizePt': { setting: '\\captionsetup{font=<size>}  (caption package)', unit: 'pt' },
  'fonts.footnote.sizePt': { setting: '\\renewcommand{\\footnotesize}  or  \\renewcommand\\footnoterule / \\@makefntext', unit: 'pt' },
  'headings.before': { setting: '\\titlespacing*{\\section}{0pt}{<before>}{<after>}  (titlesec)', alt: '\\@startsection skips in \\section', unit: 'pt' },
  'headings.after': { setting: '\\titlespacing*{\\section}{0pt}{<before>}{<after>}  (titlesec)', unit: 'pt' },
  'tableRules.thicknessPt': { setting: '\\setlength{\\arrayrulewidth}{<value>}  (\\hline)  or  \\heavyrulewidth / \\lightrulewidth (booktabs)', unit: 'pt' },
  'header.ruleThicknessPt': { setting: '\\renewcommand{\\headrulewidth}{<value>}  (fancyhdr)', unit: 'pt' },
  'header.headsepPt': { setting: '\\setlength{\\headsep}{<value>}', unit: 'pt' },
  'colors.text': { setting: '\\usepackage[<model>]{xcolor}  and  \\color{<name>}, or \\definecolor', unit: 'hex' },
  'colors.rules': { setting: '\\color{<name>} before the rule, or \\arrayrulecolor{<name>}', unit: 'hex' },
  floatPlacement: { setting: '\\begin{figure}[<spec>] / \\begin{table}[<spec>]; \\usepackage{float} for [H]', unit: 'text' },
}

/** Human names for the paper sizes the page measurement can recognise (pt). */
export const PAPER_NAMES = [
  ['A4', 595.276, 841.89],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['A5', 419.528, 595.276],
  ['A3', 841.89, 1190.55],
  ['B5', 498.9, 708.66],
  ['Executive', 521.86, 756],
]
