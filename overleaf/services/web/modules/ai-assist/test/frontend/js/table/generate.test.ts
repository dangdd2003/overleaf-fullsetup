import { expect } from 'chai'
import {
  ChatChunk,
  ChatRequest,
  ProviderSettings,
} from '../../../../frontend/js/features/ai-assist/providers/types'
import {
  buildTableResult,
  generateTable,
  previewLatex,
  TableFacts,
  tableProblems,
} from '../../../../frontend/js/features/ai-assist/table/generate'
import { parseTableReply } from '../../../../frontend/js/features/ai-assist/table/parse-output'

const settings: ProviderSettings = { type: 'anthropic', baseUrl: '', apiKey: 'k', model: 'm' }

const facts: TableFacts = {
  where: { kind: 'float' },
  habits: {
    rules: 'booktabs',
    vlines: false,
    caption: 'top',
    placement: 'htbp',
    centering: 'centering',
    size: null,
    labelStyle: 'tab:',
    envs: '',
    twoColumn: false,
    indent: '  ',
    columnTypes: new Set(),
  },
  labels: new Set(['tab:acc']),
  keepLabel: null,
  loaded: new Set(['booktabs']),
  docClass: 'article',
  colorReady: false,
  around: { lineBefore: '', lineAfter: '', indent: '' },
  values: ['A', '0.91', 'B', '0.88'],
}

const REPLY = [
  '<table env="tabular" spec="l r" label="tab:acc">',
  '<caption>Accuracy.</caption>',
  '<body>',
  '\\toprule',
  'Model & Acc. \\\\',
  '\\midrule',
  'A & 0.91 \\\\',
  'B & 0.88 \\\\',
  '\\bottomrule',
  '</body>',
  '</table>',
].join('\n')

const LATEX = [
  '\\begin{table}[htbp]',
  '  \\centering',
  '  \\caption{Accuracy.}',
  '  \\label{tab:acc-2}',
  '  \\begin{tabular}{l r}',
  '    \\toprule',
  '    Model & Acc. \\\\',
  '    \\midrule',
  '    A & 0.91 \\\\',
  '    B & 0.88 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '\\end{table}',
].join('\n')

const BROKEN = REPLY.replace('A & 0.91', 'A & 0.91 & x')

function tableOf(raw: string) {
  const parsed = parseTableReply(raw, true)
  if (parsed.kind !== 'table') throw new Error('expected a table')
  return parsed
}

function fakeClient(...replies: string[]) {
  const requests: ChatRequest[] = []
  return {
    requests,
    async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
      requests.push(request)
      const text = replies[requests.length - 1] ?? ''
      for (const piece of text.match(/[\s\S]{1,20}/g) ?? []) yield { type: 'text', text: piece }
    },
  }
}

const go = (client: ReturnType<typeof fakeClient>, onProgress = (_: unknown) => {}) =>
  generateTable({ messages: [{ role: 'user', content: 'go' }], facts, settings, client, onProgress })

describe('table: generate', function () {
  it("wraps the rows in the document's style and renames a taken label", function () {
    const result = buildTableResult(tableOf(REPLY), REPLY, facts)
    if (result.kind !== 'table') throw new Error('expected a table')
    expect(result.latex).to.equal(LATEX)
    expect(result).to.deep.include({
      label: 'tab:acc-2',
      columns: 2,
      rows: 3,
      packages: [],
      text: LATEX,
      cursorOffset: LATEX.length,
    })
    expect(result.warnings.map(warning => warning.kind)).to.deep.equal(['label'])
  })

  it('keeps the label of the table it rewrites', function () {
    const raw = REPLY.replace('tab:acc', 'tab:new')
    expect(buildTableResult(tableOf(raw), raw, { ...facts, keepLabel: 'tab:old' })).to.deep.include({
      label: 'tab:old',
    })
  })

  it('warns about a coerced environment, a wide table in one column and missing values', function () {
    const raw = REPLY.replace('<table env="tabular"', '<table env="longtable" wide="true"').replace(
      'B & 0.88 \\\\\n',
      ''
    )
    const result = buildTableResult(tableOf(raw), raw, facts)
    if (result.kind !== 'table') throw new Error('expected a table')
    expect(result.env).to.equal('tabular')
    expect(result.warnings.map(warning => warning.message)).to.deep.equal([
      'Written as tabular: longtable is not supported here.',
      'Label renamed to tab:acc-2: tab:acc is already used.',
      'Placed as a normal table: the document has one column.',
      '2 values from your data are not in the table: B, 0.88',
    ])
  })

  it('writes no caption or label where the float already has one', function () {
    const result = buildTableResult(tableOf(REPLY), REPLY, {
      ...facts,
      where: { kind: 'inner', hasCaption: true },
    })
    expect(result).to.deep.include({ caption: null, label: null })
    expect((result as { latex: string }).latex.startsWith('\\begin{tabular}{l r}')).to.equal(true)
  })

  it('lists what would not compile', function () {
    expect(tableProblems(REPLY, facts)).to.deep.equal([])
    expect(tableProblems(BROKEN, facts)).to.deep.equal([
      'Row 2 has 3 cells but the spec has 2 columns.',
    ])
    expect(tableProblems('Sorry.', facts)).to.deep.equal([
      'Reply with a <table env="…" spec="…" label="…"> block whose <body> holds the rows.',
    ])
  })

  it('previews the rows streamed so far', function () {
    const partial = parseTableReply(REPLY.slice(0, REPLY.indexOf('B & 0.88')), false)
    expect(previewLatex(partial, facts)).to.include('    A & 0.91 \\\\\n  \\end{tabular}')
    expect(previewLatex(parseTableReply('<table env="tabular"', false), facts)).to.equal(null)
  })

  it('repairs once, keeps the repair when it is better, and asks for 16384 tokens', async function () {
    const client = fakeClient(BROKEN, REPLY)
    const stages: string[] = []
    const outcome = await go(client, progress => stages.push((progress as { stage: string }).stage))
    expect(outcome).to.deep.include({ kind: 'table', rows: 3 })
    expect((outcome as { warnings: Array<{ kind: string }> }).warnings.map(w => w.kind)).to.deep.equal([
      'label',
    ])
    expect(client.requests).to.have.length(2)
    expect(client.requests[0].maxTokens).to.equal(16384)
    const repair = client.requests[1].messages[client.requests[1].messages.length - 1]
    expect(repair.content).to.include('Row 2 has 3 cells')
    expect(stages).to.include('repairing')
  })

  it('keeps the first version, saying it may not compile, when the repair is no better', async function () {
    const outcome = await go(fakeClient(BROKEN, BROKEN))
    expect((outcome as { warnings: unknown[] }).warnings[0]).to.deep.equal({
      kind: 'structure',
      message: 'This table may not compile: Row 2 has 3 cells but the spec has 2 columns.',
    })
  })

  it('reads a refusal and a missing image without a repair', async function () {
    const client = fakeClient('<cannot>no-image</cannot>')
    expect(await go(client)).to.deep.equal({ kind: 'imageUnsupported' })
    expect(client.requests).to.have.length(1)
  })
})
