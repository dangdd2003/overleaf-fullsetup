import { expect } from 'chai'
import {
  deriveSelectionActions,
  selectionActionIds,
} from '../../../../../frontend/js/features/ai-assist/agent/starters/selection-actions'
import {
  MAX_SELECTION_ACTIONS,
  MAX_SELECTION_CHIPS,
  SelectionAction,
  SelectionActionId,
  SelectionCue,
  SelectionInput,
  SelectionKind,
  SelectionScope,
} from '../../../../../frontend/js/features/ai-assist/agent/starters/selection-types'

// Typed as a full record, so an id added to the union without a line here
// fails to compile.
const KNOWN_IDS: Record<SelectionActionId, true> = {
  refine_writing: true,
  make_concise: true,
  make_scientific: true,
  fix_grammar: true,
  explain_meaning: true,
  suggest_citation: true,
  summarize_selection: true,
  prose_to_table: true,
  prose_to_list: true,
  prose_to_diagram: true,
  suggest_title: true,
  draft_section_intro: true,
  summarize_section: true,
  parallel_list: true,
  list_to_prose: true,
  list_to_table: true,
  explain_equation: true,
  check_equation: true,
  define_symbols: true,
  align_equation: true,
  equation_to_display: true,
  improve_table: true,
  fix_table: true,
  fit_table_width: true,
  table_to_chart: true,
  explain_table: true,
  improve_caption: true,
  reference_figure: true,
  figure_to_subfigures: true,
  explain_tikz: true,
  polish_tikz: true,
  fix_tikz: true,
  annotate_tikz: true,
  explain_code: true,
  format_listing: true,
  explain_packages: true,
  clean_preamble: true,
  fix_bibtex: true,
  complete_bibtex: true,
  verify_citation: true,
  find_more_sources: true,
  explain_latex: true,
  fix_latex_errors: true,
  change_formatting: true,
  define_term: true,
  tighten_abstract: true,
}
const ALL_IDS = Object.keys(KNOWN_IDS) as SelectionActionId[]

const EXPECTED_ORDER: Record<SelectionKind, SelectionActionId[]> = {
  prose: [
    'refine_writing',
    'make_concise',
    'fix_grammar',
    'explain_meaning',
    'suggest_citation',
    'make_scientific',
    'prose_to_list',
    'prose_to_diagram',
  ],
  heading: [
    'suggest_title',
    'draft_section_intro',
    'summarize_section',
    'fix_grammar',
  ],
  list: [
    'parallel_list',
    'list_to_prose',
    'list_to_table',
    'refine_writing',
    'make_concise',
  ],
  math: [
    'explain_equation',
    'check_equation',
    'define_symbols',
    'align_equation',
  ],
  table: [
    'improve_table',
    'fix_table',
    'fit_table_width',
    'table_to_chart',
    'explain_table',
  ],
  figure: [
    'improve_caption',
    'reference_figure',
    'figure_to_subfigures',
    'fix_latex_errors',
    'explain_latex',
  ],
  tikz: ['explain_tikz', 'polish_tikz', 'fix_tikz', 'annotate_tikz'],
  code: ['explain_code', 'format_listing', 'fix_latex_errors'],
  preamble: ['explain_packages', 'clean_preamble', 'fix_latex_errors'],
  bibtex: ['fix_bibtex', 'complete_bibtex'],
  citation: ['verify_citation', 'find_more_sources'],
  latex: ['explain_latex', 'fix_latex_errors', 'change_formatting'],
}
const KINDS = Object.keys(EXPECTED_ORDER) as SelectionKind[]

const EDIT_IDS: SelectionActionId[] = [
  'refine_writing',
  'make_concise',
  'make_scientific',
  'fix_grammar',
  'prose_to_table',
  'prose_to_list',
  'prose_to_diagram',
  'draft_section_intro',
  'parallel_list',
  'list_to_prose',
  'list_to_table',
  'check_equation',
  'define_symbols',
  'align_equation',
  'equation_to_display',
  'improve_table',
  'fix_table',
  'fit_table_width',
  'table_to_chart',
  'improve_caption',
  'reference_figure',
  'figure_to_subfigures',
  'polish_tikz',
  'fix_tikz',
  'annotate_tikz',
  'format_listing',
  'clean_preamble',
  'fix_bibtex',
  'complete_bibtex',
  'fix_latex_errors',
  'tighten_abstract',
]

/** Ids whose prompts ask for a \label, which must reach the model with one backslash. */
const LABEL_IDS: SelectionActionId[] = [
  'prose_to_table',
  'prose_to_diagram',
  'list_to_table',
  'improve_caption',
  'reference_figure',
  'figure_to_subfigures',
  'align_equation',
  'equation_to_display',
  'format_listing',
  'table_to_chart',
]

const TABULAR = [
  '\\begin{tabular}{lcc}',
  'Model & Acc & F1 \\\\',
  'BERT & 91.2 & 90.1 \\\\',
  '\\end{tabular}',
].join('\n')

function scope(
  kind: SelectionKind,
  overrides: Partial<SelectionScope> = {}
): SelectionScope {
  return {
    kind,
    env: null,
    lines: 1,
    numeric: false,
    inline: false,
    ...overrides,
  }
}

function input(
  selectionScope: SelectionScope,
  {
    from = 3,
    to = 7,
    path = 'main.tex',
  }: { from?: number; to?: number; path?: string } = {}
): SelectionInput {
  return { path, from, to, text: 'Selected text.', scope: selectionScope }
}

/** Every action a kind can produce, across the flag variants, keyed by id. */
function actionsByEveryPath(): Map<SelectionActionId, SelectionAction> {
  const found = new Map<SelectionActionId, SelectionAction>()
  const variants: Array<Partial<SelectionScope>> = [
    {},
    { numeric: true, lines: 12 },
    { inline: true },
    { cues: ['term'] },
    { cues: ['abstract'] },
  ]
  for (const kind of KINDS) {
    for (const variant of variants) {
      for (const action of deriveSelectionActions(
        input(scope(kind, variant)),
        99
      )) {
        found.set(action.id, action)
      }
    }
  }
  return found
}

const PROSE_NUMERIC: SelectionActionId[] = [
  'refine_writing',
  'prose_to_table',
  'make_concise',
  'fix_grammar',
  'explain_meaning',
  'suggest_citation',
  'make_scientific',
  'prose_to_list',
  'prose_to_diagram',
]

const PROSE_LONG: SelectionActionId[] = [
  'refine_writing',
  'make_concise',
  'summarize_selection',
  'fix_grammar',
  'explain_meaning',
  'suggest_citation',
  'make_scientific',
  'prose_to_list',
  'prose_to_diagram',
]

const PROSE_NUMERIC_LONG: SelectionActionId[] = [
  'refine_writing',
  'prose_to_table',
  'summarize_selection',
  'make_concise',
  'fix_grammar',
  'explain_meaning',
  'suggest_citation',
  'make_scientific',
  'prose_to_list',
  'prose_to_diagram',
]

const INLINE_MATH: SelectionActionId[] = [
  'explain_equation',
  'equation_to_display',
  'check_equation',
  'define_symbols',
]

describe('selectionActionIds', function () {
  it('ranks each kind in the spec order', function () {
    for (const kind of KINDS) {
      expect(selectionActionIds(scope(kind)), kind).to.deep.equal(
        EXPECTED_ORDER[kind]
      )
    }
  })

  it('puts prose_to_table second when prose states several numbers', function () {
    expect(
      selectionActionIds(scope('prose', { numeric: true }))
    ).to.deep.equal(PROSE_NUMERIC)
  })

  it('puts summarize_selection third from eight lines up', function () {
    expect(selectionActionIds(scope('prose', { lines: 8 }))).to.deep.equal(
      PROSE_LONG
    )
    expect(selectionActionIds(scope('prose', { lines: 7 }))).to.deep.equal(
      EXPECTED_ORDER.prose
    )
  })

  it('applies both prose adjustments in order', function () {
    expect(
      selectionActionIds(scope('prose', { numeric: true, lines: 12 }))
    ).to.deep.equal(PROSE_NUMERIC_LONG)
  })

  it('adjusts only prose for numbers and length', function () {
    expect(
      selectionActionIds(scope('list', { numeric: true, lines: 12 }))
    ).to.deep.equal(EXPECTED_ORDER.list)
    expect(
      selectionActionIds(scope('heading', { numeric: true, lines: 12 }))
    ).to.deep.equal(EXPECTED_ORDER.heading)
  })

  it('offers equation_to_display second in place of align_equation for inline math', function () {
    const ids = selectionActionIds(scope('math', { inline: true }))
    expect(ids).to.deep.equal(INLINE_MATH)
    expect(ids).to.not.include('align_equation')
  })

  it('keeps each call independent, so adjustments never leak', function () {
    const numeric = scope('prose', { numeric: true, lines: 12 })
    const first = selectionActionIds(numeric)
    expect(selectionActionIds(scope('prose'))).to.deep.equal(
      EXPECTED_ORDER.prose
    )
    expect(selectionActionIds(numeric)).to.deep.equal(first)
  })
})

describe('selectionActionIds with content cues', function () {
  const prose = (...cues: SelectionCue[]) =>
    selectionActionIds(scope('prose', { cues }))

  it('ranks as before with no cues or an empty list', function () {
    expect(prose()).to.deep.equal(EXPECTED_ORDER.prose)
    expect(selectionActionIds(scope('prose', { cues: undefined }))).to.deep.equal(EXPECTED_ORDER.prose)
  })

  it('offers define_term first for a term, in prose and in LaTeX', function () {
    expect(prose('term')).to.deep.equal([
      'define_term',
      'explain_meaning',
      'suggest_citation',
      'fix_grammar',
    ])
    expect(selectionActionIds(scope('latex', { cues: ['term'] }))).to.deep.equal([
      'define_term',
      'explain_meaning',
      'suggest_citation',
      'change_formatting',
    ])
  })

  it('moves the matching action into the top cards for each cue', function () {
    expect(prose('uncited_claim').slice(0, 2)).to.deep.equal(['refine_writing', 'suggest_citation'])
    expect(prose('introduction').slice(0, 2)).to.deep.equal(['refine_writing', 'suggest_citation'])
    expect(prose('informal').slice(0, 2)).to.deep.equal(['refine_writing', 'make_scientific'])
    expect(prose('wordy').slice(0, 2)).to.deep.equal(['refine_writing', 'make_concise'])
    expect(prose('enumeration')[2]).to.equal('prose_to_list')
    expect(prose('process')[2]).to.equal('prose_to_diagram')
    expect(prose('abstract')[0]).to.equal('tighten_abstract')
  })

  it('surfaces actions the fixed order hid below the cards', function () {
    for (const [cue, id] of [
      ['informal', 'make_scientific'],
      ['enumeration', 'prose_to_list'],
      ['process', 'prose_to_diagram'],
    ] as Array<[SelectionCue, SelectionActionId]>) {
      expect(EXPECTED_ORDER.prose.indexOf(id), id).to.be.at.least(MAX_SELECTION_ACTIONS)
      expect(prose(cue).slice(0, MAX_SELECTION_ACTIONS), cue).to.include(id)
    }
  })

  it('lets the stronger cue win the same slot', function () {
    expect(prose('wordy', 'informal', 'uncited_claim').slice(0, 4)).to.deep.equal([
      'refine_writing',
      'suggest_citation',
      'make_scientific',
      'make_concise',
    ])
    expect(prose('process', 'enumeration').slice(2, 4)).to.deep.equal(['prose_to_list', 'prose_to_diagram'])
  })

  it('combines cues with the numeric and length adjustments', function () {
    const ids = selectionActionIds(scope('prose', { numeric: true, lines: 12, cues: ['uncited_claim'] }))
    expect(ids.slice(0, 4)).to.deep.equal([
      'refine_writing',
      'suggest_citation',
      'prose_to_table',
      'summarize_selection',
    ])
  })

  it('never lists an action twice', function () {
    const all: SelectionCue[] = ['process', 'enumeration', 'wordy', 'informal', 'introduction', 'uncited_claim', 'abstract']
    const ids = prose(...all)
    expect(new Set(ids).size).to.equal(ids.length)
  })

  it('ignores prose cues on other kinds', function () {
    expect(selectionActionIds(scope('list', { cues: ['informal', 'abstract'] }))).to.deep.equal(EXPECTED_ORDER.list)
    expect(selectionActionIds(scope('table', { cues: ['term'] }))).to.deep.equal(EXPECTED_ORDER.table)
  })
})

describe('deriveSelectionActions', function () {
  it('returns id, prompt and edits for each action in rank order', function () {
    const actions = deriveSelectionActions(input(scope('table')))
    expect(actions.map(action => action.id)).to.deep.equal(EXPECTED_ORDER.table)
    expect(actions[0]).to.have.all.keys('id', 'prompt', 'edits')
    expect(actions[0].edits).to.equal(true)
    expect(actions[4]).to.include({ id: 'explain_table', edits: false })
  })

  it('is deterministic for the same selection', function () {
    const selection = input(scope('prose', { numeric: true, lines: 9 }))
    expect(deriveSelectionActions(selection)).to.deep.equal(
      deriveSelectionActions(selection)
    )
  })

  it('caps the list at MAX_SELECTION_ACTIONS by default', function () {
    const actions = deriveSelectionActions(
      input(scope('prose', { numeric: true, lines: 12 }))
    )
    expect(actions).to.have.lengthOf(MAX_SELECTION_ACTIONS)
    expect(actions.map(action => action.id)).to.deep.equal(
      PROSE_NUMERIC_LONG.slice(0, MAX_SELECTION_ACTIONS)
    )
  })

  it('honours an explicit max', function () {
    const selection = input(scope('table'))
    expect(
      deriveSelectionActions(selection, MAX_SELECTION_CHIPS).map(
        action => action.id
      )
    ).to.deep.equal(EXPECTED_ORDER.table.slice(0, MAX_SELECTION_CHIPS))
    expect(deriveSelectionActions(selection, 0)).to.deep.equal([])
    expect(deriveSelectionActions(selection, 99)).to.have.lengthOf(
      EXPECTED_ORDER.table.length
    )
  })

  it('names a single line in the where wording', function () {
    const actions = deriveSelectionActions(
      input(scope('math', { inline: true }), {
        from: 5,
        to: 5,
        path: 'sections/intro.tex',
      })
    )
    expect(actions[0].prompt).to.include('(line 5 of sections/intro.tex)')
    expect(actions[0].prompt).to.not.match(/lines \d/)
  })

  it('names a multi-line range in the where wording', function () {
    const actions = deriveSelectionActions(input(scope('table')))
    expect(actions[0].prompt).to.include('(lines 3-7 of main.tex)')
    expect(actions[0].prompt).to.not.match(/line 3 of/)
  })

  it('puts the where wording in every prompt', function () {
    const found = actionsByEveryPath()
    for (const action of found.values()) {
      expect(action.prompt, action.id).to.include('lines 3-7 of main.tex')
    }
  })

  it('has a prompt for every SelectionActionId', function () {
    const found = actionsByEveryPath()
    expect([...found.keys()].sort()).to.deep.equal([...ALL_IDS].sort())
    for (const action of found.values()) {
      expect(action.prompt, action.id).to.be.a('string').and.not.be.empty
    }
  })

  it('marks exactly the ✎ actions as edits', function () {
    const found = actionsByEveryPath()
    const edits = [...found.values()]
      .filter(action => action.edits)
      .map(action => action.id)
    expect(edits.sort()).to.deep.equal([...EDIT_IDS].sort())
  })

  it('writes \\label with a single backslash at runtime', function () {
    const found = actionsByEveryPath()
    for (const id of LABEL_IDS) {
      const prompt = found.get(id)!.prompt
      expect(prompt, id).to.include('\\label')
      expect(prompt, id).to.not.include('\\\\label')
    }
    expect(found.get('reference_figure')!.prompt).to.include('\\ref')
  })

  it('keeps the doubled backslash in fix_table', function () {
    const prompt = actionsByEveryPath().get('fix_table')!.prompt
    expect(prompt).to.include('missing \\\\, stray &')
  })

  it('writes no other prompt with a doubled backslash', function () {
    for (const action of actionsByEveryPath().values()) {
      if (action.id === 'fix_table') continue
      expect(action.prompt, action.id).to.not.include('\\\\')
    }
  })

  // The only test that depends on classifySelectionText, through the fallback.
  it('falls back to classifySelectionText when no scope is given', function () {
    const actions = deriveSelectionActions({
      path: 'main.tex',
      from: 10,
      to: 13,
      text: TABULAR,
    })
    expect(actions[0].id).to.equal('improve_table')
  })
})
