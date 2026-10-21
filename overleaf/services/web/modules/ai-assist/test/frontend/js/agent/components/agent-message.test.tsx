import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, within, act } from '@testing-library/react'
import {
  AgentMessageView,
  EditedCodeBadge,
} from '../../../../../frontend/js/features/ai-assist/components/agent/agent-message'
import { TranscriptEntry } from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'

function mockClipboard(writeTextStub: sinon.SinonStub) {
  const clipboardObj = { writeText: writeTextStub }
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboardObj,
      configurable: true,
      writable: true,
    })
  }
  if (typeof window !== 'undefined' && window.navigator) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: clipboardObj,
      configurable: true,
      writable: true,
    })
  }
}

function actionLabels(container: HTMLElement, rowSelector: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(`${rowSelector} button`)
  ).map(btn => btn.getAttribute('aria-label'))
}

describe('AgentMessageView Actions & Badges', function () {
  let clock: sinon.SinonFakeTimers | null = null

  afterEach(function () {
    if (clock) {
      clock.restore()
      clock = null
    }
    sinon.restore()
  })

  describe('User Message Small Function Buttons Under Prompt', function () {
    const userEntry: TranscriptEntry = {
      id: 'u1',
      role: 'user',
      text: 'Please rewrite the introduction to be more concise.',
      createdAt: Date.now() - 33 * 60 * 1000,
    }

    it('renders small function buttons (Copy, Rewind, Fork) under user prompt', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      expect(container.querySelector('.ai-assist-user-turn-wrapper')).to.exist
      expect(container.querySelector('.ai-assist-user-message-footer')).to.exist
      expect(container.querySelector('.ai-assist-user-message-status')).to.exist

      const actionBtns = container.querySelectorAll(
        '.ai-assist-msg-actions-user button'
      )
      expect(actionBtns.length).to.equal(3)
    })

    it('shows one tick while sent and two once the run has read it', function () {
      const { container, rerender } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )
      const status = () =>
        container.querySelector('.ai-assist-user-message-status')!
      expect(status().getAttribute('aria-label')).to.equal('Sent')
      expect(status().classList.contains('is-read')).to.be.false

      rerender(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          read
        />
      )
      expect(status().getAttribute('aria-label')).to.equal(
        'Read by the assistant'
      )
      expect(status().classList.contains('is-read')).to.be.true
    })

    it('orders user buttons Fork, Rewind, Copy so Copy sits at the right edge', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      expect(
        actionLabels(container, '.ai-assist-msg-actions-user')
      ).to.deep.equal([
        'Fork conversation from here',
        'Rewind',
        'Copy',
      ])
    })

    it('copies prompt text and shows Copied feedback when Copy button is clicked', async function () {
      const writeTextStub = sinon.stub().resolves()
      mockClipboard(writeTextStub)
      const onCopyPrompt = sinon.stub()

      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onCopyPrompt={onCopyPrompt}
        />
      )

      const copyBtn = within(container).getByRole('button', {
        name: 'Copy',
      }) as HTMLButtonElement
      fireEvent.click(copyBtn)
      await Promise.resolve()

      expect(writeTextStub.calledWith(userEntry.text)).to.be.true
      expect(onCopyPrompt.calledWith(userEntry.text)).to.be.true
      expect(copyBtn.classList.contains('is-copied')).to.be.true
      expect(copyBtn.getAttribute('aria-label')).to.equal('Copied')
    })

    it('calls onRewindCode or onRewindPrompt when Rewind button is clicked', function () {
      const onRewindCode = sinon.stub()
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onRewindCode={onRewindCode}
        />
      )

      fireEvent.click(within(container).getByRole('button', { name: 'Rewind' }))

      expect(onRewindCode.calledWith(userEntry, false)).to.be.true
    })

    it('calls onRewindPrompt if onRewindCode is not provided', function () {
      const onRewindPrompt = sinon.stub()
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onRewindPrompt={onRewindPrompt}
        />
      )

      fireEvent.click(within(container).getByRole('button', { name: 'Rewind' }))

      expect(onRewindPrompt.calledWith(userEntry)).to.be.true
    })

    it('calls onForkFromPrompt when Fork button is clicked', function () {
      const onForkFromPrompt = sinon.stub()
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onForkFromPrompt={onForkFromPrompt}
        />
      )

      fireEvent.click(
        within(container).getByRole('button', {
          name: 'Fork conversation from here',
        })
      )

      expect(onForkFromPrompt.calledWith(userEntry, false)).to.be.true
    })

    it('disables Rewind and Fork but not Copy when actionsDisabled is set', function () {
      const onRewindCode = sinon.stub()
      const { container } = render(
        <AgentMessageView
          entry={userEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onRewindCode={onRewindCode}
          actionsDisabled
        />
      )

      const scope = within(container)
      fireEvent.click(scope.getByRole('button', { name: 'Rewind' }))
      expect(onRewindCode.called).to.be.false
      expect(
        (scope.getByRole('button', { name: 'Rewind' }) as HTMLButtonElement).getAttribute('aria-disabled') === 'true'
      ).to.be.true
      expect(
        (
          scope.getByRole('button', {
            name: 'Fork conversation from here',
          }) as HTMLButtonElement
        ).getAttribute('aria-disabled') === 'true'
      ).to.be.true
      expect((scope.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).getAttribute('aria-disabled') === 'true')
        .to.be.false
    })

    it('does not render footer buttons when user entry is queued/pending', function () {
      const pendingEntry: TranscriptEntry = {
        ...userEntry,
        pending: true,
      }
      const { container } = render(
        <AgentMessageView
          entry={pendingEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      expect(container.querySelector('.ai-assist-user-message-footer')).to.not.exist
      expect(container.querySelector('.ai-assist-queued-row')).to.exist
    })
  })

  describe('Assistant Message Actions (Copy & Regenerate)', function () {
    const assistantEntry: TranscriptEntry = {
      id: 'a1',
      role: 'assistant',
      text: 'Here is the rewritten section:\n\n```latex\n\\section{Introduction}\n```',
      toolCalls: [],
    }

    it('renders copy and regenerate buttons on complete assistant message', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      const scope = within(container)
      expect(scope.getByRole('button', { name: 'Copy' })).to.exist
      expect(scope.getByRole('button', { name: 'Regenerate' })).to.exist
    })

    it('renders assistant action buttons as icon only', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      const buttons = container.querySelectorAll<HTMLButtonElement>(
        '.ai-assist-msg-actions-assistant button'
      )
      expect(buttons.length).to.equal(2)
      buttons.forEach(btn => expect(btn.textContent).to.equal(''))
    })

    it('orders assistant buttons Copy, Regenerate from the left edge', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      expect(
        actionLabels(container, '.ai-assist-msg-actions-assistant')
      ).to.deep.equal(['Copy', 'Regenerate'])
    })

    it('copies markdown text and shows Copied for 2 seconds', async function () {
      clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      })
      const writeTextStub = sinon.stub().resolves()
      mockClipboard(writeTextStub)
      const onCopyResponse = sinon.stub()

      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onCopyResponse={onCopyResponse}
          isRunning={false}
        />
      )

      const copyBtn = within(container).getByRole('button', {
        name: 'Copy',
      }) as HTMLButtonElement
      fireEvent.click(copyBtn)
      await Promise.resolve()

      expect(writeTextStub.calledWith(assistantEntry.text)).to.be.true
      expect(onCopyResponse.calledWith(assistantEntry.text)).to.be.true
      expect(copyBtn.getAttribute('aria-label')).to.equal('Copied')
      expect(copyBtn.classList.contains('is-copied')).to.be.true

      // Forward 1900ms: still copied
      act(() => {
        clock?.tick(1900)
      })
      expect(copyBtn.getAttribute('aria-label')).to.equal('Copied')

      // Forward past 2000ms: reverts to Copy
      act(() => {
        clock?.tick(200)
      })
      expect(copyBtn.getAttribute('aria-label')).to.equal('Copy')
      expect(copyBtn.classList.contains('is-copied')).to.be.false
    })

    it('falls back to execCommand when the Clipboard API is unavailable', function () {
      // Hide the Clipboard API on both globals (mockClipboard may have set either)
      for (const nav of [navigator, window.navigator]) {
        Object.defineProperty(nav, 'clipboard', {
          value: undefined,
          configurable: true,
          writable: true,
        })
      }
      const execCommand = sinon.stub().returns(true)
      Object.defineProperty(document, 'execCommand', {
        value: execCommand,
        configurable: true,
        writable: true,
      })

      try {
        const { container } = render(
          <AgentMessageView
            entry={assistantEntry}
            pendingApprovalId={null}
            onDecision={sinon.stub()}
            isRunning={false}
          />
        )

        fireEvent.click(within(container).getByRole('button', { name: 'Copy' }))

        expect(execCommand.calledWith('copy')).to.be.true
        expect(within(container).getByRole('button', { name: 'Copied' })).to.exist
      } finally {
        for (const nav of [navigator, window.navigator]) {
          delete (nav as any).clipboard
        }
        delete (document as any).execCommand
      }
    })

    it('calls onRegenerate when Regenerate button is clicked', function () {
      const onRegenerate = sinon.stub()
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onRegenerate={onRegenerate}
          isRunning={false}
        />
      )

      fireEvent.click(within(container).getByRole('button', { name: 'Regenerate' }))

      expect(onRegenerate.calledWith(assistantEntry)).to.be.true
    })

    it('dispatches aiAssist:regenerate event when onRegenerate prop is not provided', function () {
      const eventSpy = sinon.spy()
      window.addEventListener('aiAssist:regenerate', eventSpy)

      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      fireEvent.click(within(container).getByRole('button', { name: 'Regenerate' }))

      expect(eventSpy.calledOnce).to.be.true
      window.removeEventListener('aiAssist:regenerate', eventSpy)
    })

    it('disables Regenerate but not Copy when actionsDisabled is set', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
          actionsDisabled
        />
      )

      const scope = within(container)
      expect(
        (scope.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).getAttribute('aria-disabled') === 'true'
      ).to.be.true
      expect((scope.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).getAttribute('aria-disabled') === 'true')
        .to.be.false
    })

    it('hides Regenerate when isLatestAssistant is false but keeps Copy', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantEntry}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
          isLatestAssistant={false}
        />
      )

      const scope = within(container)
      expect(scope.queryByRole('button', { name: 'Regenerate' })).to.be.null
      expect(scope.getByRole('button', { name: 'Copy' })).to.exist
    })
  })

  describe('Edited Code Summary Badge', function () {
    const assistantWithEdits: TranscriptEntry = {
      id: 'a2',
      role: 'assistant',
      text: 'I have updated the document with your changes.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'edit_file',
          args: {
            path: 'main.tex',
            oldText: 'Old title\nFirst line\nSecond line',
            newText: 'New title\nFirst line\nUpdated second line\nThird line added\nFourth line added',
          },
          result: { status: 'applied', startLine: 12 },
        },
      ],
    }

    it('renders the Edited code summary badge with diff stats and file name', function () {
      const { container } = render(
        <AgentMessageView
          entry={assistantWithEdits}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      const badge = container.querySelector(
        '.ai-assist-edited-code-badge'
      ) as HTMLButtonElement
      expect(badge).to.exist
      expect(badge.textContent).to.contain('Edited code')
      expect(badge.textContent).to.contain('main.tex')
      expect(badge.querySelector('.ai-assist-diff-stat-added')).to.exist
      expect(badge.querySelector('.ai-assist-diff-stat-removed')).to.exist
    })

    it('does not render the Edited code badge when there are no file edit tool calls', function () {
      const assistantNoEdits: TranscriptEntry = {
        id: 'a3',
        role: 'assistant',
        text: 'Just reading files.',
        toolCalls: [
          {
            id: 'call-r1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: { content: 'test content' },
          },
        ],
      }

      const { container } = render(
        <AgentMessageView
          entry={assistantNoEdits}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      expect(container.querySelector('.ai-assist-edited-code-badge')).to.not.exist
    })

    it('triggers file jump and diff review when the Edited code badge is clicked', function () {
      const onFileJump = sinon.stub()
      const onDiffReview = sinon.stub()
      const openDiffSpy = sinon.spy()
      window.addEventListener('aiAssist:openDiff', openDiffSpy)

      const { container } = render(
        <AgentMessageView
          entry={assistantWithEdits}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          onFileJump={onFileJump}
          onDiffReview={onDiffReview}
          isRunning={false}
        />
      )

      const badge = container.querySelector(
        '.ai-assist-edited-code-badge'
      ) as HTMLButtonElement
      fireEvent.click(badge)

      expect(onFileJump.calledWith('main.tex', 12)).to.be.true
      expect(onDiffReview.calledWith(assistantWithEdits, 'main.tex')).to.be.true
      expect(openDiffSpy.calledOnce).to.be.true

      window.removeEventListener('aiAssist:openDiff', openDiffSpy)
    })

    it('renders create_file tool call in the edited code badge', function () {
      const assistantWithCreate: TranscriptEntry = {
        id: 'a4',
        role: 'assistant',
        text: 'Created new bibliography.',
        toolCalls: [
          {
            id: 'call-c1',
            name: 'create_file',
            args: {
              path: 'references.bib',
              content: '@article{smith2024,\n  title={Paper}\n}',
            },
            result: { status: 'applied' },
          },
        ],
      }

      const { container } = render(
        <AgentMessageView
          entry={assistantWithCreate}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
          isRunning={false}
        />
      )

      const badge = container.querySelector(
        '.ai-assist-edited-code-badge'
      ) as HTMLButtonElement
      expect(badge).to.exist
      expect(badge.textContent).to.contain('references.bib')
      expect(badge.querySelector('.ai-assist-diff-stat-added')?.textContent).to.contain('+3')
    })
  })

  describe('User Message Image Gallery', function () {
    const userEntryWithImages: TranscriptEntry = {
      id: 'u-img-1',
      role: 'user',
      text: 'What is shown in these figures?',
      images: [
        { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
        { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
      ],
    }

    it('renders image gallery with thumbnails for user message with images', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntryWithImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      const grid = container.querySelector('.ai-assist-user-images-grid')
      expect(grid).to.exist

      const thumbs = container.querySelectorAll('.ai-assist-user-image-thumb')
      expect(thumbs.length).to.equal(2)

      const img1 = thumbs[0].querySelector('img')
      expect(img1).to.exist
      expect(img1?.getAttribute('src')).to.equal(
        `data:image/png;base64,${userEntryWithImages.images![0].data}`
      )
      expect(img1?.getAttribute('alt')).to.equal('Attached photo')

      const img2 = thumbs[1].querySelector('img')
      expect(img2).to.exist
      expect(img2?.getAttribute('src')).to.equal(
        `data:image/jpeg;base64,${userEntryWithImages.images![1].data}`
      )
      expect(img2?.getAttribute('alt')).to.equal('Attached photo')
    })

    it('opens image popup lightbox when clicking an image thumbnail without opening a new tab', function () {
      const windowOpenStub = sinon.stub(window, 'open')

      const { container } = render(
        <AgentMessageView
          entry={userEntryWithImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      const firstImg = container.querySelector('.ai-assist-user-image-thumb img') as HTMLImageElement
      expect(firstImg).to.exist
      fireEvent.click(firstImg)

      // Must NOT open new about:blank window/tab
      expect(windowOpenStub.called).to.be.false

      // Must display the lightbox popup in the DOM
      const overlay = document.querySelector('.ai-assist-lightbox-overlay')
      expect(overlay).to.exist

      const popupImg = overlay?.querySelector('.ai-assist-lightbox-image') as HTMLImageElement
      expect(popupImg).to.exist
      expect(popupImg.src).to.equal(
        `data:image/png;base64,${userEntryWithImages.images![0].data}`
      )
    })

    it('closes the image popup lightbox when clicking the close button', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntryWithImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      const firstImg = container.querySelector('.ai-assist-user-image-thumb img') as HTMLImageElement
      fireEvent.click(firstImg)

      const overlay = document.querySelector('.ai-assist-lightbox-overlay')
      expect(overlay).to.exist

      const closeBtn = document.querySelector('.ai-assist-lightbox-close-btn') as HTMLButtonElement
      expect(closeBtn).to.exist
      fireEvent.click(closeBtn)

      // Lightbox should close
      expect(document.querySelector('.ai-assist-lightbox-overlay')).to.not.exist
    })

    it('closes the image popup lightbox when pressing Escape', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntryWithImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      const firstImg = container.querySelector('.ai-assist-user-image-thumb img') as HTMLImageElement
      fireEvent.click(firstImg)

      expect(document.querySelector('.ai-assist-lightbox-overlay')).to.exist

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(document.querySelector('.ai-assist-lightbox-overlay')).to.not.exist
    })

    it('closes when clicking backdrop but not when clicking inside image container', function () {
      const { container } = render(
        <AgentMessageView
          entry={userEntryWithImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      const firstImg = container.querySelector('.ai-assist-user-image-thumb img') as HTMLImageElement
      fireEvent.click(firstImg)

      const overlay = document.querySelector('.ai-assist-lightbox-overlay') as HTMLElement
      const popupImg = document.querySelector('.ai-assist-lightbox-image') as HTMLImageElement

      // Clicking image does not close
      fireEvent.click(popupImg)
      expect(document.querySelector('.ai-assist-lightbox-overlay')).to.exist

      // Clicking overlay backdrop closes
      fireEvent.click(overlay)
      expect(document.querySelector('.ai-assist-lightbox-overlay')).to.not.exist
    })

    it('does not render image gallery when user message has no images', function () {
      const userEntryNoImages: TranscriptEntry = {
        id: 'u-no-img',
        role: 'user',
        text: 'No images here',
      }

      const { container } = render(
        <AgentMessageView
          entry={userEntryNoImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      expect(container.querySelector('.ai-assist-user-images-grid')).to.not.exist
    })

    it('does not render image gallery when images array is empty', function () {
      const userEntryEmptyImages: TranscriptEntry = {
        id: 'u-empty-img',
        role: 'user',
        text: 'Empty images array',
        images: [],
      }

      const { container } = render(
        <AgentMessageView
          entry={userEntryEmptyImages}
          pendingApprovalId={null}
          onDecision={sinon.stub()}
        />
      )

      expect(container.querySelector('.ai-assist-user-images-grid')).to.not.exist
    })
  })
})
