import { expect } from 'chai'
import { renderEnvelope } from '../../../../frontend/js/features/ai-assist/agent/context/project-context'
import { ContextSnapshot } from '../../../../frontend/js/features/ai-assist/agent/context/types'

const BASE_SNAPSHOT: ContextSnapshot = {
  rootDocPath: 'main.tex',
  files: [{ path: 'main.tex', type: 'doc', size: 100, lines: 10 }],
  openFile: null,
  selection: null,
  compile: null,
}

describe('renderEnvelope outline section', function () {
  it('renders section hierarchy with line ranges in the envelope', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections: [
          { path: 'main.tex', line: 5, level: 1, title: 'Introduction', numbered: true },
          { path: 'main.tex', line: 15, level: 2, title: 'Background', numbered: true },
        ],
      },
    }

    const { text, state } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.include('<outline>')
    expect(text).to.include('main.tex:5 Introduction')
    expect(text).to.include('main.tex:15 Background')
    expect(text).to.include('</outline>')
    expect(state.outlineFingerprint).to.be.a('string')
  })

  it('delta-encodes unchanged outline on subsequent turn', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections: [
          { path: 'main.tex', line: 5, level: 1, title: 'Introduction', numbered: true },
        ],
      },
    }

    const first = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    const second = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 2,
      previous: first.state,
    })

    expect(second.text).to.include('<outline>unchanged since turn 1</outline>')
  })

  it('omits outline block completely when project has no sections', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: null,
    }

    const { text } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.not.include('<outline>')
  })

  it('caps at 40 sections and renders an overflow count', function () {
    const sections = Array.from({ length: 45 }, (_, i) => ({
      path: 'main.tex',
      line: i * 10,
      level: 1,
      title: `Section ${i + 1}`,
      numbered: true,
    }))

    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections,
      },
    }

    const { text } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.include('Section 40')
    expect(text).to.not.include('Section 41')
    expect(text).to.include('(+5 more sections)')
  })
})
