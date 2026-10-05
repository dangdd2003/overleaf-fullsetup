import { expect } from 'chai'
import {
  applyChunkFades,
  createFadeState,
} from '../../../../frontend/js/features/ai-assist/components/agent/stream-fade'

function render(html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

function faded(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.ai-assist-stream-fade'))
}

describe('applyChunkFades', function () {
  it('fades a new list item whole and still fades words added to it later', function () {
    const state = createFadeState()
    const first = render('<ul><li>Alpha</li></ul>')
    applyChunkFades(first, state)
    expect(first.querySelector('li')!.classList.contains('ai-assist-stream-fade'))
      .to.be.true

    const second = render('<ul><li>Alpha beta gamma</li></ul>')
    applyChunkFades(second, state)
    const words = faded(second).filter(el => el.tagName === 'SPAN')
    expect(words.map(el => el.textContent?.trim())).to.include.members([
      'beta',
      'gamma',
    ])
  })

  it('fades words added to a table row that is already fading', function () {
    const state = createFadeState()
    applyChunkFades(
      render('<table><tbody><tr><td>one</td></tr></tbody></table>'),
      state
    )
    const next = render(
      '<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>'
    )
    applyChunkFades(next, state)
    const spans = faded(next).filter(el => el.tagName === 'SPAN')
    expect(spans.map(el => el.textContent)).to.deep.equal(['two'])
  })

  it('fades a new code block whole and the code streaming into it', function () {
    const state = createFadeState()
    applyChunkFades(
      render(
        '<div class="ai-assist-code-block"><span>latex</span><pre><code>\\begin</code></pre></div>'
      ),
      state
    )
    const next = render(
      '<div class="ai-assist-code-block"><span>latex</span><pre><code>\\begin{document} text</code></pre></div>'
    )
    applyChunkFades(next, state)
    expect(
      next
        .querySelector('.ai-assist-code-block')!
        .classList.contains('ai-assist-stream-fade')
    ).to.be.true
    expect(
      faded(next).some(el => el.tagName === 'SPAN' && el.closest('code'))
    ).to.be.true
  })

  it('fades a new rule and does not refade one already on screen', function () {
    const state = createFadeState(render('<p>a</p><hr>'))
    const container = render('<p>a</p><hr><p>b</p><hr>')
    applyChunkFades(container, state)
    const rules = Array.from(container.querySelectorAll('hr'))
    expect(rules[0].classList.contains('ai-assist-stream-fade')).to.be.false
    expect(rules[1].classList.contains('ai-assist-stream-fade')).to.be.true
  })
})
