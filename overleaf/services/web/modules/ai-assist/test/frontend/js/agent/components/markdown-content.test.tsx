import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, waitFor } from '@testing-library/react'
import {
  MarkdownContent,
  copyTextToClipboard,
} from '../../../../../frontend/js/features/ai-assist/components/agent/markdown-content'
import { holdBackIncomplete } from '../../../../../frontend/js/features/ai-assist/hooks/use-stream-reveal'

describe('MarkdownContent', function () {
  it('renders bold, italic, and paragraphs', function () {
    const { container } = render(
      <MarkdownContent content="This is **bold** and *italic* text." />
    )

    expect(container.querySelector('strong')?.textContent).to.equal('bold')
    expect(container.querySelector('em')?.textContent).to.equal('italic')
    expect(container.querySelector('p')).to.exist
  })

  it('renders inline code and code blocks', function () {
    const md = [
      'Here is `\\section{intro}`:',
      '```latex',
      '\\section{Conclusion}',
      '\\label{sec:conclusion}',
      '```',
    ].join('\n')

    const { container } = render(<MarkdownContent content={md} />)

    const inlineCode = container.querySelector('p > code')
    expect(inlineCode?.textContent).to.equal('\\section{intro}')

    const pre = container.querySelector('pre')
    expect(pre).to.exist
    const blockCode = pre?.querySelector('code')
    expect(blockCode?.className).to.contain('language-latex')
    expect(blockCode?.textContent).to.contain('\\section{Conclusion}')
  })

  it('renders ordered and unordered lists', function () {
    const md = ['- Item A', '- Item B', '1. First', '2. Second'].join('\n')
    const { container } = render(<MarkdownContent content={md} />)

    expect(container.querySelectorAll('ul > li')).to.have.length(2)
    expect(container.querySelectorAll('ol > li')).to.have.length(2)
  })

  it('adds target="_blank" and rel to links', function () {
    const { container } = render(
      <MarkdownContent content="[Overleaf](https://www.overleaf.com)" />
    )

    const link = container.querySelector('a')
    expect(link).to.exist
    expect(link?.getAttribute('href')).to.equal('https://www.overleaf.com')
    expect(link?.getAttribute('target')).to.equal('_blank')
    expect(link?.getAttribute('rel')).to.equal('noreferrer noopener')
  })

  it('sanitizes malicious script tags and event handlers', function () {
    const malicious =
      'Hello <script>alert("xss")</script><img src="x" onerror="alert(1)">'
    const { container } = render(<MarkdownContent content={malicious} />)

    expect(container.querySelector('script')).to.not.exist
    expect(container.querySelector('img')).to.not.exist
    expect(container.textContent).to.contain('Hello')
  })

  it('renders nothing for empty or null content', function () {
    const { container } = render(<MarkdownContent content="" />)
    expect(container.firstChild).to.be.null
  })

  it('renders markdown tables with wrapper and headers', function () {
    const md = [
      '| Section | Statement | Suggested citation type |',
      '| :--- | :--- | :--- |',
      '| Contributions | "Novel algorithm" | Theoretical |',
    ].join('\n')

    const { container } = render(<MarkdownContent content={md} />)

    expect(container.querySelector('.ai-assist-table-wrapper')).to.exist
    expect(container.querySelector('table')).to.exist
    expect(container.querySelectorAll('th')).to.have.length(3)
    expect(container.querySelectorAll('td')).to.have.length(3)
    expect(container.querySelector('th')?.textContent).to.equal('Section')
    expect(container.querySelector('td')?.textContent).to.equal('Contributions')
  })

  it('renders a copy button on code blocks that sends code to device clipboard', async function () {
    const md = [
      '```latex',
      '\\begin{equation}',
      '  E = mc^2',
      '\\end{equation}',
      '```',
    ].join('\n')

    const writeTextStub = sinon.stub().resolves()
    const originalClipboard = (navigator as any).clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextStub },
      configurable: true,
      writable: true,
    })

    try {
      const { container } = render(<MarkdownContent content={md} />)

      const block = container.querySelector('.ai-assist-code-block')
      expect(block).to.exist

      const langSpan = block?.querySelector('.ai-assist-code-lang')
      expect(langSpan?.textContent).to.equal('latex')

      const copyBtn = block?.querySelector('.ai-assist-code-copy-btn') as HTMLButtonElement
      expect(copyBtn).to.exist
      expect(copyBtn.querySelector('.ai-assist-icon-copy')).to.exist
      expect(copyBtn.querySelector('.ai-assist-icon-check')).to.exist
      expect(copyBtn.textContent).to.contain('Copy')

      fireEvent.click(copyBtn)

      // Wait for promise resolution
      await new Promise(r => setTimeout(r, 10))

      expect(writeTextStub.calledOnce).to.be.true
      expect(writeTextStub.firstCall.args[0]).to.contain('E = mc^2')
      expect(writeTextStub.firstCall.args[0]).to.contain('\\begin{equation}')

      expect(copyBtn.classList.contains('is-copied')).to.be.true
      expect(copyBtn.textContent).to.contain('Copied!')
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      })
    }
  })

  it('copyTextToClipboard falls back when navigator.clipboard fails', async function () {
    const originalClipboard = (navigator as any).clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const originalExecCommand = (document as any).execCommand
    const execCommandStub = sinon.stub().returns(true)
    ;(document as any).execCommand = execCommandStub

    try {
      const res = await copyTextToClipboard('\\section{Test}')
      expect(res).to.be.true
      expect(execCommandStub.calledWith('copy')).to.be.true
    } finally {
      ;(document as any).execCommand = originalExecCommand
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      })
    }
  })

  it('renders display math equations as human readable formulas instead of raw code', function () {
    const md = [
      'The Fourier transform is:',
      '$$\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(t) e^{-2\\pi i t \\xi} , dt$$',
    ].join('\n')

    const { container } = render(<MarkdownContent content={md} />)

    expect(container.textContent).to.not.contain('$$\\hat{f}(\\xi)')
    const katexDisplay = container.querySelector('.katex-display')
    expect(katexDisplay).to.exist
    expect(katexDisplay?.querySelector('.katex-html')).to.exist
  })

  it('renders inline math and bracket/environment delimiters with KaTeX', function () {
    const md = [
      'Inline formula $E = mc^2$ and parenthesized \\( \\alpha + \\beta \\).',
      'Bracket style:',
      '\\[ \\sum_{k=1}^n k = \\frac{n(n+1)}{2} \\]',
      'Environment style:',
      '\\begin{equation}',
      '  a^2 + b^2 = c^2',
      '\\end{equation}',
    ].join('\n')

    const { container } = render(<MarkdownContent content={md} />)

    expect(container.textContent).to.not.contain('$E = mc^2$')
    expect(container.textContent).to.not.contain('\\[')
    expect(container.querySelectorAll('.katex')).to.have.length.at.least(3)
  })

  it('renders markdown task list checkboxes', function () {
    const md = ['- [ ] Pending item', '- [x] Completed item'].join('\n')

    const { container } = render(<MarkdownContent content={md} />)

    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).to.have.length(2)
    expect((checkboxes[0] as HTMLInputElement).checked).to.be.false
    expect((checkboxes[1] as HTMLInputElement).checked).to.be.true
    expect((checkboxes[0] as HTMLInputElement).disabled).to.be.true
  })

  it('renders an insert button on code blocks that dispatches insertion events', function () {
    const md = [
      '```latex',
      '\\begin{table}',
      '  \\caption{Sample}',
      '\\end{table}',
      '```',
    ].join('\n')

    let snippetEvent: any = null
    let symbolEvent: any = null

    const snippetListener = (e: any) => {
      snippetEvent = e.detail
    }
    const symbolListener = (e: any) => {
      symbolEvent = e.detail
    }

    window.addEventListener('aiAssist:insertSnippet', snippetListener)
    window.addEventListener('editor:insert-symbol', symbolListener)

    try {
      const { container } = render(<MarkdownContent content={md} />)

      const insertBtn = container.querySelector('.ai-assist-code-insert-btn') as HTMLButtonElement
      expect(insertBtn).to.exist
      expect(insertBtn.textContent).to.contain('Insert')

      fireEvent.click(insertBtn)

      expect(snippetEvent).to.deep.equal({
        text: '\\begin{table}\n  \\caption{Sample}\n\\end{table}',
      })
      expect(symbolEvent).to.deep.equal({
        command: '\\begin{table}\n  \\caption{Sample}\n\\end{table}',
      })
      expect(insertBtn.classList.contains('is-inserted')).to.be.true
      expect(insertBtn.textContent).to.contain('Inserted!')
    } finally {
      window.removeEventListener('aiAssist:insertSnippet', snippetListener)
      window.removeEventListener('editor:insert-symbol', symbolListener)
    }
  })

  it('renders an insert button on markdown tables and converts to LaTeX on click', function () {
    const md = [
      '| Section | Claim | Suggested Citation |',
      '| :--- | :--- | :--- |',
      '| Intro | Transformers | Vaswani et al. |',
      '| Method | LSTMs | Hochreiter |',
    ].join('\n')

    let snippetEvent: any = null
    const snippetListener = (e: any) => {
      snippetEvent = e.detail
    }
    window.addEventListener('aiAssist:insertSnippet', snippetListener)

    try {
      const { container } = render(<MarkdownContent content={md} />)

      const tableInsertBtn = container.querySelector(
        '.ai-assist-table-insert-btn'
      ) as HTMLButtonElement
      expect(tableInsertBtn).to.exist
      expect(tableInsertBtn.textContent).to.contain('Insert')

      fireEvent.click(tableInsertBtn)

      expect(snippetEvent).to.exist
      expect(snippetEvent.text).to.contain('\\begin{table}[htbp]')
      expect(snippetEvent.text).to.contain('\\begin{tabular}{lll}')
      expect(snippetEvent.text).to.contain('Transformers')
      expect(snippetEvent.text).to.contain('Vaswani et al.')
      expect(snippetEvent.text).to.contain('\\bottomrule')

      expect(tableInsertBtn.classList.contains('is-inserted')).to.be.true
      expect(tableInsertBtn.textContent).to.contain('Inserted!')
    } finally {
      window.removeEventListener('aiAssist:insertSnippet', snippetListener)
    }
  })

  it('detects mentioned files in AI responses and opens them on click or enter', function () {
    const md =
      'That text is located in sections/discussion.tex under the subsection "The Emergence of Heuristics". Also see main.tex:42 and references.bib.'

    const openFileStub = sinon.stub()
    const { container } = render(
      <MarkdownContent content={md} onOpenFile={openFileStub} />
    )

    const fileButtons = container.querySelectorAll<HTMLButtonElement>(
      '.ai-assist-file-mention'
    )
    expect(fileButtons).to.have.length(3)

    expect(fileButtons[0].getAttribute('data-path')).to.equal(
      'sections/discussion.tex'
    )
    expect(fileButtons[1].getAttribute('data-path')).to.equal('main.tex')
    expect(fileButtons[1].getAttribute('data-line')).to.equal('42')
    expect(fileButtons[2].getAttribute('data-path')).to.equal('references.bib')

    // Click on sections/discussion.tex
    fireEvent.click(fileButtons[0])
    expect(openFileStub.calledOnce).to.be.true
    expect(openFileStub.firstCall.args[0]).to.equal('sections/discussion.tex')
    expect(openFileStub.firstCall.args[1]).to.be.undefined

    // Press Enter on main.tex:42
    fireEvent.keyDown(fileButtons[1], { key: 'Enter' })
    expect(openFileStub.calledTwice).to.be.true
    expect(openFileStub.secondCall.args[0]).to.equal('main.tex')
    expect(openFileStub.secondCall.args[1]).to.equal(42)
  })

  it('renders file mentions as clean inline link buttons without svg icons', function () {
    const md = 'Check out main.tex and src/table.tex:15 for details.'
    const { container } = render(<MarkdownContent content={md} />)

    const fileMentions = container.querySelectorAll('.ai-assist-file-mention')
    expect(fileMentions).to.have.length(2)

    fileMentions.forEach(mention => {
      expect(mention.querySelector('svg')).to.not.exist
      expect(mention.querySelector('.ai-assist-file-icon')).to.not.exist
    })

    expect(fileMentions[0].textContent).to.equal('main.tex')
    expect(fileMentions[1].textContent).to.equal('src/table.tex:15')
  })

  it('reveals live text progressively, fading in the new words', async function () {
    const { container } = render(
      <MarkdownContent
        content="First clause, second clause. Still arriving"
        isLive={true}
      />
    )

    expect(container.textContent).to.not.contain('Still')
    await waitFor(() =>
      expect(container.textContent).to.contain('second clause.')
    )
    const markdown = container.querySelector('.ai-assist-markdown')
    expect(markdown?.classList.contains('is-streaming')).to.be.true
    expect(container.querySelectorAll('.ai-assist-stream-fade').length).to.be
      .greaterThan(0)
    expect(container.querySelector('.ai-assist-stream-word')).to.not.exist
    expect(container.querySelector('.ai-assist-streaming-cursor')).to.not.exist
  })

  it('renders tables as real tables while streaming', async function () {
    const md = 'Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    const { container } = render(<MarkdownContent content={md} isLive />)

    await waitFor(() =>
      expect(container.querySelectorAll('.ai-assist-table tr')).to.have.length(2)
    )
    expect(container.textContent).to.not.contain('|')
  })

  it('shows the rest and stops animating once the stream ends', async function () {
    const { container, rerender } = render(
      <MarkdownContent content="Done here. Last word" isLive />
    )
    rerender(<MarkdownContent content="Done here. Last word" isLive={false} />)

    await waitFor(
      () => {
        expect(container.textContent).to.contain('Last word')
        expect(
          container.querySelector('.ai-assist-markdown')?.classList.contains(
            'is-streaming'
          )
        ).to.be.false
      },
      { timeout: 2000 }
    )
  })

  it('does not animate a message that is not live', function () {
    const { container } = render(
      <MarkdownContent content="Completed response" isLive={false} />
    )

    expect(container.textContent).to.contain('Completed response')
    expect(container.querySelectorAll('.ai-assist-stream-fade')).to.have.length(0)
    expect(container.querySelector('.ai-assist-markdown')?.classList.contains('is-streaming')).to.be.false
  })
})

describe('holdBackIncomplete', function () {
  it('holds a table header until its delimiter row arrives', function () {
    const text = 'Intro.\n| a | b |\n'
    expect(holdBackIncomplete(text, text.length)).to.equal('Intro.\n'.length)
    const partialDelimiter = `${text}|--`
    expect(holdBackIncomplete(partialDelimiter, partialDelimiter.length)).to.equal(
      'Intro.\n'.length
    )
    const withDelimiter = `${text}|---|---|\n| 1 | 2`
    expect(holdBackIncomplete(withDelimiter, withDelimiter.length)).to.equal(
      withDelimiter.length
    )
  })

  it('holds an unclosed display-math block', function () {
    const text = 'See:\n$$\n\\frac{a}{b'
    expect(holdBackIncomplete(text, text.length)).to.equal('See:\n'.length)
  })

  it('streams code freely but holds a partial fence line', function () {
    const text = '```latex\n\\begin{equation}\nx = 1\n\\end{equ'
    expect(holdBackIncomplete(text, text.length)).to.equal(text.length)
    const closing = '```latex\nx = 1\n``'
    expect(holdBackIncomplete(closing, closing.length)).to.equal(
      closing.lastIndexOf('\n') + 1
    )
    const opening = 'Code:\n```la'
    expect(holdBackIncomplete(opening, opening.length)).to.equal('Code:\n'.length)
  })

  it('holds an unclosed inline marker', function () {
    const text = 'This is **very imp'
    expect(holdBackIncomplete(text, text.length)).to.equal('This is '.length)
  })
})
