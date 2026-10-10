import { expect } from 'chai'
import { cleanCompletion, MAX_BLOCK_LINES } from '../../../../frontend/js/features/ai-assist/completion/clean'
import type { CompletionKind } from '../../../../frontend/js/features/ai-assist/completion/detect'

const chat = (kind: CompletionKind, before: string, after = '') => ({ kind, before, after })
const prose = (reply: string, before: string, done = true) =>
  cleanCompletion(reply, done, chat('prose', before))

describe('completion: cleaning the reply', function () {
  describe('a remark to the author instead of text', function () {
    it('shows nothing of it and stops reading', function () {
      for (const reply of [
        'It appears your LaTeX code was cut off.',
        'It looks like your LaTeX document got cut off mid-sentence!',
        'Your LaTeX code contains a syntax error.',
        'Compilation failed with 1 error.',
        'LaTeX Error: undefined control sequence.',
        "It seems the provided text is incomplete. Could you share more context?",
        "Sure! Here's the next item for your document:",
        'I need more context to know what you would like at the cursor.',
      ]) {
        expect(cleanCompletion(reply, false, chat('block', 'x\n')), reply).to.deep.equal({ text: '', complete: true })
        expect(cleanCompletion(reply, true, chat('prose', 'x')), reply).to.deep.equal({ text: '', complete: true })
      }
    })

    it('waits while a reply opens like one, then keeps the document text', function () {
      expect(prose('It appears', 'Text.', false)).to.deep.equal({ text: '', complete: false })
      expect(prose('It appears that the solver converges in every case we tried.', 'Text.').text).to.equal(
        ' It appears that the solver converges in every case we tried.'
      )
      expect(prose('Here we compare the two methods.', 'Text.').text).to.equal(' Here we compare the two methods.')
    })
  })

  it('rejects root preamble commands when already inside document body', function () {
    const inBody = '\\documentclass{article}\n\\begin{document}\nHello, my name is Dang, im '
    expect(cleanCompletion('\\documentclass{article}', true, chat('prose', inBody))).to.deep.equal({
      text: '',
      complete: true,
    })
    expect(cleanCompletion('\\begin{document}', true, chat('prose', inBody))).to.deep.equal({
      text: '',
      complete: true,
    })
  })

  it('unwraps completion tags if present', function () {
    expect(prose('<completion> works nicely.</completion>', 'Our method').text).to.equal(' works nicely.')
  })

  it("drops the request's own markers when the model echoes them", function () {
    expect(prose('<cursor/>works nicely.', 'Our method').text).to.equal(' works nicely.')
    expect(prose('<excerpt>\nworks nicely.\n</excerpt>', 'Our method').text).to.equal(' works nicely.')
    expect(prose('works <', 'Our method', false).text).to.equal(' works ')
  })

  it('keeps prose that merely mentions errors or things not found', function () {
    expect(prose('no solution was found when the error exceeded the tolerance.', 'In this case').text).to.equal(
      ' no solution was found when the error exceeded the tolerance.'
    )
    expect(prose('error bars show one standard deviation.', 'The').text).to.equal(
      ' error bars show one standard deviation.'
    )
    expect(prose('Error: undefined control sequence', 'x')).to.deep.equal({ text: '', complete: true })
  })

  describe('prose from a chat model', function () {
    it('adds the space after a word', function () {
      expect(prose('outperforms the baseline.', 'Our method')).to.deep.equal({
        text: ' outperforms the baseline.',
        complete: true,
      })
    })

    it('adds no second space when the text already ends with one', function () {
      expect(prose(' outperforms it.', 'Our method ').text).to.equal('outperforms it.')
    })

    it('adds no space after an opening bracket', function () {
      expect(prose('see Section 2).', 'as shown (').text).to.equal('see Section 2).')
    })

    it('drops text the reply repeats from before the cursor', function () {
      expect(prose('our method outperforms it.', 'In short, our method').text).to.equal(' outperforms it.')
    })

    it('shows nothing while the reply may still be repeating', function () {
      expect(prose('In sh', 'In short, our method', false)).to.deep.equal({ text: '', complete: false })
    })

    it('cuts at the end of the sentence and says it is complete', function () {
      expect(prose('processing. Then we', 'rapid', false)).to.deep.equal({ text: ' processing.', complete: true })
    })

    it('waits at a final full stop while streaming', function () {
      expect(prose('processing.', 'rapid', false)).to.deep.equal({ text: ' processing.', complete: false })
    })

    it('does not cut after abbreviations', function () {
      expect(prose('as in Fig. 3 and e.g. Table 2. More', 'shown', false).text).to.equal(
        ' as in Fig. 3 and e.g. Table 2.'
      )
    })

    it('does not cut inside braces', function () {
      expect(prose('the \\textit{a. b} works. Next', 'and', false).text).to.equal(' the \\textit{a. b} works.')
    })

    it('strips code fences and quotes', function () {
      expect(prose('```\nthe baseline.\n```', 'beats').text).to.equal(' the baseline.')
      expect(prose('"the baseline."', 'beats').text).to.equal(' the baseline.')
      expect(prose('``', 'beats', false).text).to.equal('')
    })

    it('stops at a paragraph break', function () {
      expect(prose('the end\n\nNew paragraph', 'reach', false)).to.deep.equal({ text: ' the end', complete: true })
    })

    it('returns nothing for an empty reply', function () {
      expect(prose('', 'x')).to.deep.equal({ text: '', complete: false })
      expect(prose('   ', 'x')).to.deep.equal({ text: '', complete: false })
    })

    it('drops a closer the reply repeats from after the cursor', function () {
      expect(
        cleanCompletion('important results}', true, chat('prose', 'See \\textbf{', '}\nNext')).text
      ).to.equal('important results')
    })

    it('keeps a balanced closer and short word overlaps', function () {
      expect(cleanCompletion('a \\emph{b}', true, chat('prose', 'x', '} y')).text).to.equal(' a \\emph{b}')
      expect(cleanCompletion('is a', true, chat('prose', 'This', 'a test')).text).to.equal(' is a')
    })
  })

  describe('blocks, math and code', function () {
    it('block: keeps the leading newline, stops after the closing \\end', function () {
      expect(
        cleanCompletion(
          '\nc & d \\\\\n\\end{tabular}\nAfter',
          false,
          chat('block', 'a & b \\\\')
        )
      ).to.deep.equal({ text: '\nc & d \\\\\n\\end{tabular}', complete: true })
    })

    it('block: an environment opened inside the reply does not stop it', function () {
      expect(
        cleanCompletion('\\begin{x}\ny\n\\end{x}\nmore\n\nnext', false, chat('block', ''))
      ).to.deep.equal({ text: '\\begin{x}\n    y\n\\end{x}\nmore', complete: true })
    })

    it('block and code: at most MAX_BLOCK_LINES lines', function () {
      const reply = Array.from({ length: MAX_BLOCK_LINES + 2 }, (_, i) => `l${i}`).join('\n')
      const { text, complete } = cleanCompletion(reply, false, chat('code', 'x = 1\n'))
      expect(text.split('\n')).to.have.length(MAX_BLOCK_LINES)
      expect(complete).to.equal(true)
    })

    it('math: the rest of the line, without the closing $ it repeats', function () {
      expect(cleanCompletion('b^2 = c^2$\nmore', false, chat('math', '$a^2 +', '$'))).to.deep.equal({
        text: 'b^2 = c^2',
        complete: true,
      })
    })
  })

  describe('held to where the cursor is', function () {
    const base = {
      newLine: false,
      sameLine: false,
      indent: '',
      forbidBegin: [] as string[],
      forbidEnd: [] as string[],
      rows: null,
      argumentOf: null,
      envs: [] as any[],
      region: 'body' as const,
      argumentClosed: true,
      rowEndAfter: false,
      announces: null,
    }
    const held = (reply: string, kind: any, before: string, situation: any, after = '') =>
      cleanCompletion(reply, true, { kind, before, after, situation: { ...base, ...situation } })

    it('never opens a second table inside the table being written', function () {
      const situation = {
        envs: [{ name: 'tabular' }],
        forbidBegin: ['tabular', 'table'],
        forbidEnd: ['tabular'],
        rows: { columns: 3, separatorsBefore: 0, atRowStart: true },
        newLine: true,
        indent: '    ',
      }
      const { text } = held(
        '\nOurs & 12 & 3 \\\\\n\\begin{tabular}{lll}\na & b & c\n\\end{tabular}',
        'block',
        'Name & Size & Time \\\\',
        situation
      )
      expect(text).to.equal('\n    Ours & 12 & 3 \\\\')
    })

    it('drops cells a row has no room for, and an \\end the text already has', function () {
      const situation = {
        envs: [{ name: 'tabular' }],
        forbidEnd: ['tabular'],
        rows: { columns: 3, separatorsBefore: 1, atRowStart: false },
      }
      expect(held('12 & 3 & 99 & 7 \\\\', 'prose', 'Ours & ', situation).text).to.equal('12 & 3')
      expect(held('3 \\\\\n\\end{tabular}', 'block', 'Ours & 12 & ', { ...situation, rows: { columns: 3, separatorsBefore: 2, atRowStart: false } }).text).to.equal('3 \\\\')
    })

    it('puts what follows \\section{…} on the next line', function () {
      expect(held('\\begin{itemize}\n\\item One', 'block', '\\section{Method}', { newLine: true }).text).to.equal(
        '\n\\begin{itemize}\n    \\item One\n\\end{itemize}'
      )
      expect(held('We propose a solver.', 'block', '\\section{Method}', { newLine: true }).text).to.equal(
        '\nWe propose a solver.'
      )
    })

    it('keeps a mid-sentence reply on this line', function () {
      expect(held('three datasets\n\\begin{table}', 'prose', 'We trained on', { sameLine: true }).text).to.equal(
        ' three datasets'
      )
    })

    it('ends a heading at its closing brace, with no section inside an environment', function () {
      expect(held('three datasets} and more', 'prose', '\\section{Results on', { argumentOf: 'section' }).text).to.equal(
        ' three datasets'
      )
      expect(
        held('One more point.\n\\section{Next}', 'block', '\\item First.', { envs: [{ name: 'itemize' }] }).text
      ).to.equal('One more point.')
    })

    it('closes an argument whose brace is not written yet, and stops there', function () {
      expect(
        held('three datasets} and more', 'prose', '\\section{Results on', { argumentOf: 'section', argumentClosed: false }).text
      ).to.equal(' three datasets}')
    })

    it("ends a row before the \\\\ the line already has", function () {
      const situation = {
        envs: [{ name: 'tabular' }],
        rows: { columns: 3, separatorsBefore: 1, atRowStart: false },
        rowEndAfter: true,
      }
      expect(held('12 & 3 \\\\\n4 & 5 & 6 \\\\', 'prose', 'Ours & ', situation, ' \\\\').text).to.equal('12 & 3')
    })

    it('places a block structure starting with \\begin on a newline when following prose', function () {
      const before = 'define these tables using the environments.'
      const reply = '\\begin{table}[htbp]\n\\centering\n\\end{table}'
      const { text } = cleanCompletion(reply, true, {
        kind: 'block',
        before,
        after: '\n\nSome more text',
        situation: { ...base, indent: '' },
      })
      expect(text.startsWith('\n\n\\begin{table}')).to.equal(true)
    })

    it('cuts off a duplicate table when the suffix already begins with a table', function () {
      const before = 'define these tables using the environments.'
      const reply = '\\begin{table}[htbp]\n\\centering\n\\end{table}'
      const res = cleanCompletion(reply, true, {
        kind: 'block',
        before,
        after: '\n\n\\begin{table}\n\\centering\n\\end{table}',
        situation: { ...base, forbidBegin: ['table', 'table*', 'tabular'] },
      })
      expect(res.text).to.equal('')
    })

    it('cuts off loop tables inside an existing table', function () {
      const before = '    Alpha & 10 \\\\'
      const reply = '\n\\begin{tabular}{ll}\nBeta & 20\n\\end{tabular}'
      const res = cleanCompletion(reply, true, {
        kind: 'block',
        before,
        after: '\n  \\end{tabular}',
        situation: {
          ...base,
          envs: [
            { name: 'table', role: 'float' as const, begin: '\\begin{table}', closedAfter: true },
            { name: 'tabular', role: 'rows' as const, begin: '\\begin{tabular}{ll}', closedAfter: true },
          ],
          rows: { columns: 2, separatorsBefore: 0, atRowStart: true, header: 'Alpha & 10' },
          forbidBegin: ['table', 'tabular'],
        },
      })
      expect(res.text).to.equal('')
    })
  })
  describe('LaTeX blocks are never glued to the sentence before them', function () {
    const base = {
      newLine: false,
      sameLine: false,
      indent: '',
      forbidBegin: [] as string[],
      forbidEnd: [] as string[],
      rows: null,
      argumentOf: null,
      envs: [] as any[],
      region: 'body' as const,
      argumentClosed: true,
      rowEndAfter: false,
      announces: null,
    }
    const clean = (reply: string, kind: CompletionKind, before: string, situation: any = {}, done = true) =>
      cleanCompletion(reply, done, { kind, before, after: '', situation: { ...base, ...situation } })

    it('prose: a sentence that introduces an equation puts it on its own lines', function () {
      const { text, complete } = clean(
        'as follows: \\begin{equation} E = mc^2. \\end{equation} where m is the mass.',
        'prose',
        'The energy is written',
        { sameLine: true }
      )
      expect(text).to.equal(' as follows:\n\\begin{equation}\n    E = mc^2.\n\\end{equation}')
      expect(complete).to.equal(true)
    })

    it('prose: a full stop inside the display does not cut it', function () {
      expect(clean('\\[ a = b. \\]', 'prose', 'We obtain').text).to.equal('\n\\[\n    a = b.\n\\]')
    })

    it('prose: a display the reply leaves open is closed for it, never dropped', function () {
      expect(clean('as follows:\n\\begin{align}\n  a &= b', 'prose', 'It reads', { sameLine: true }).text).to.equal(
        ' as follows:\n\\begin{align}\n  a &= b\n\\end{align}'
      )
      // Cut off by the output limit inside a table: closed at every level
      expect(
        clean('\\begin{table}[h]\n\\centering\n\\begin{tabular}{lc}\nA & B \\\\\n1 & 2', 'block', 'These are the tables: ', { newLine: true, announces: 'table' }).text
      ).to.equal(
        '\n\\begin{table}[h]\n    \\centering\n    \\begin{tabular}{lc}\n        A & B \\\\\n        1 & 2\n    \\end{tabular}\n\\end{table}'
      )
      // An environment with nothing in it yet is no content
      expect(clean('three datasets\n\\begin{table}[h]', 'prose', 'We trained on', { sameLine: true }).text).to.equal(' three datasets')
      expect(clean('as follows:\n\\begin{align}\n  a &= b', 'prose', 'It reads', { sameLine: true }, false).text).to.include('\\begin{align}')
    })

    it('prose: runs into a table or figure up to its end, but stops before a heading', function () {
      expect(clean('are listed below \\begin{table}[h] x \\end{table} More text.', 'prose', 'Results', { sameLine: true }).text).to.equal(
        ' are listed below\n\\begin{table}[h]\n    x\n\\end{table}'
      )
      expect(clean('here \\section{Next}', 'prose', 'We stop').text).to.equal(' here')
    })

    it('block: an announced table is shown whole, however many lines, and ends at its \\end', function () {
      const rows = Array.from({ length: 20 }, (_, i) => `        Row ${i} & ${i} \\\\[2pt]`)
      const table = [
        '\\begin{table}[h]',
        '    \\centering',
        '    \\begin{tabular}{lc}',
        '        \\hline',
        '',
        ...rows,
        '        \\hline',
        '    \\end{tabular}',
        '    \\caption{Example.}',
        '\\end{table}',
      ].join('\n')
      const { text, complete } = clean(`${table}\n\nAfter it.`, 'block', 'This is the example tables: ', { newLine: true, announces: 'table' }, false)
      expect(text).to.equal(`\n${table}`)
      expect(complete).to.equal(true)
    })

    it('a preamble command in the body ends the reply there, the text before it stays', function () {
      expect(clean('rests on it. \\usepackage{x}', 'prose', '\\begin{document}\nThe method').text).to.equal(' rests on it.')
    })

    it('block: a one-line table becomes one row per line, each part on its own line', function () {
      const { text } = clean(
        'Table 1 sums it up. \\begin{table}[t] \\centering \\begin{tabular}{lc} \\toprule A & B \\\\ \\midrule 1 & 2 \\\\ \\bottomrule \\end{tabular} \\caption{Sum.} \\end{table}',
        'block',
        ''
      )
      expect(text).to.equal(
        [
          'Table 1 sums it up.',
          '\\begin{table}[t]',
          '    \\centering',
          '    \\begin{tabular}{lc}',
          '        \\toprule',
          '        A & B \\\\ \\midrule',
          '        1 & 2 \\\\ \\bottomrule',
          '    \\end{tabular}',
          '    \\caption{Sum.}',
          '\\end{table}',
        ].join('\n')
      )
    })

    it('block: rows written on one line inside a table go one per line, at the row indent', function () {
      const { text } = clean('1 & 2 \\\\ \\hline 3 & 4 \\\\', 'block', '  a & b \\\\', {
        envs: [{ name: 'tabular' }],
        rows: { columns: 2, separatorsBefore: 0, atRowStart: true },
        newLine: true,
        indent: '  ',
      })
      expect(text).to.equal('\n  1 & 2 \\\\ \\hline\n  3 & 4 \\\\')
    })

    it('a block glued to the sentence is moved to the next line', function () {
      expect(clean(' \\begin{itemize} \\item a \\item b \\end{itemize}', 'block', 'It has two parts:').text).to.equal(
        '\n\\begin{itemize}\n    \\item a\n    \\item b\n\\end{itemize}'
      )
    })

    it('leaves inline math, matrices and cases alone', function () {
      expect(clean('where $A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$.', 'prose', 'Let').text).to.equal(
        ' where $A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$.'
      )
    })

    it('holds back a command the stream has cut short', function () {
      expect(clean('as shown \\beg', 'prose', 'It works', {}, false).text).to.equal(' as shown ')
    })
  })
})
