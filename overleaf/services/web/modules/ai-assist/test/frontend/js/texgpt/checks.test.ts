import { expect } from 'chai'
import {
  editWarnings,
  missingPackages,
  packageWarning,
  structureProblems,
} from '../../../../frontend/js/features/ai-assist/texgpt/checks'

describe('texgpt: checks', function () {
  it('flags unclosed environments and braces in new code', function () {
    expect(structureProblems('', '\\begin{table}\n\\caption{x')).to.deep.equal([
      '\\begin{table} has no matching \\end{table}',
      'Braces { } do not balance',
    ])
    expect(structureProblems('', '\\begin{table}\\end{table}')).to.deep.equal([])
  })

  it('accepts the same imbalance the selection already had', function () {
    const partial = '\\begin{itemize}\n\\item a'
    expect(structureProblems(partial, '\\begin{itemize}\n\\item A')).to.deep.equal([])
    expect(structureProblems(partial, '\\item A')).to.deep.equal([
      '\\end{itemize} has no matching \\begin{itemize}',
    ])
  })

  it('finds packages the code needs and the project lacks', function () {
    const code = '\\toprule\n\\begin{align}x\\end{align}\n% \\multirow'
    expect(
      missingPackages(code, ['siunitx'], new Set(['mathtools']), 'article')
    ).to.deep.equal(['siunitx', 'booktabs'])
    expect(missingPackages(code, [], new Set(), 'acmart')).to.deep.equal([])
  })

  it('words the package warning for one or several packages', function () {
    expect(packageWarning(['booktabs'])!.message).to.equal(
      'Uses booktabs, which this project does not load'
    )
    expect(packageWarning(['a', 'b', 'c'])!.message).to.equal(
      'Uses a, b and c, which this project does not load'
    )
    expect(packageWarning([])).to.equal(null)
  })

  it('reports dropped keys and changed math when editing a selection', function () {
    const kinds = editWarnings('As \\cite{a} shows, $x$.', 'As shown, $y$.').map(
      warning => warning.kind
    )
    expect(kinds).to.deep.equal(['droppedKey', 'math'])
  })
})
