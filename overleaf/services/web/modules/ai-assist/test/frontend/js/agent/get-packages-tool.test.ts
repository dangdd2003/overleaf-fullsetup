import { expect } from 'chai'
import { getPackagesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-packages'
import { createFakeHandle } from './helpers/fake-handle'

describe('get_packages', function () {
  it('takes no parameters at all', function () {
    const params = getPackagesTool.spec.parameters as any
    expect(params.properties).to.deep.equal({})
    expect(params.required).to.deep.equal([])
  })

  it('cannot change the project', function () {
    expect(getPackagesTool.mutates).to.equal(false)
  })

  it('returns the documentclass and every package with where it is loaded', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n',
      },
    })
    const result: any = await getPackagesTool.execute({}, handle)
    expect(result.documentClass).to.equal('article')
    const graphicx = result.packages.find((p: any) => p.name === 'graphicx')
    expect(graphicx.path).to.equal('main.tex')
    expect(graphicx.line).to.equal(2)
  })

  it('renders human-readable text representations', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n',
      },
    })
    const result: any = await getPackagesTool.execute({}, handle)
    expect(getPackagesTool.render!(result)).to.include('graphicx')
  })

  it('returns package options and compiler settings', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\usepackage[table,dvipsnames]{xcolor}\n',
      },
    })
    const result: any = await getPackagesTool.execute({}, handle)
    expect(result.documentClass).to.equal('article')
    expect(result.compiler).to.equal('pdflatex')
    const xcolor = result.packages.find((p: any) => p.name === 'xcolor')
    expect(xcolor.options).to.equal('table,dvipsnames')
    expect(xcolor.path).to.equal('main.tex')
    expect(xcolor.line).to.equal(2)
  })

  it('renders package options and compiler in output', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\usepackage[table]{xcolor}\n',
      },
    })
    const result: any = await getPackagesTool.execute({}, handle)
    const rendered = getPackagesTool.render!(result)
    expect(rendered).to.include('compiler: pdflatex')
    expect(rendered).to.include('xcolor [table]  (main.tex:2)')
  })
})
