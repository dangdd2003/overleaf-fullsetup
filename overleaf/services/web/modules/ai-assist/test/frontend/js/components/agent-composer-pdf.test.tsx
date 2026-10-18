import { expect } from 'chai'
import sinon from 'sinon'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { AgentComposer } from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'
import type { PdfAreaContext } from '../../../../frontend/js/features/ai-assist/agent/context/types'
import { updatePdfTurnContext } from '../../../../frontend/js/features/ai-assist/pdf/turn-context'
import { publishPdfViewer } from '@/features/pdf-preview/util/viewer-bridge'

const PATHS = ['main.tex']

/** Changes the PDF store the way the viewer does, flushed into the DOM. */
function setPdf(patch: Parameters<typeof updatePdfTurnContext>[0]) {
  act(() => {
    updatePdfTurnContext(patch)
  })
}

function renderComposer(
  overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}
) {
  const onSend = sinon.stub()
  const utils = render(
    <AgentComposer
      running={false}
      paths={PATHS}
      onSend={onSend}
      onStop={sinon.stub()}
      {...overrides}
    />
  )
  return { ...utils, onSend }
}

const AREA: PdfAreaContext = {
  page: 3,
  source: { path: 'main.tex', line: 4, endLine: 9 },
  rect: { x: 10, y: 20, w: 100, h: 50 },
  image: { mediaType: 'image/png', data: 'AAAA' },
}

describe('AgentComposer PDF context', function () {
  beforeEach(function () {
    window.metaAttributesCache = new Map([['ol-aiAssistEnabled', true]])
    // A viewer on screen; the composer reads only that it is there
    publishPdfViewer({} as never)
  })

  afterEach(function () {
    publishPdfViewer(null)
    window.metaAttributesCache = new Map()
    setPdf({
      selections: [],
      areas: [],
      pendingAreas: 0,
      boxSelecting: false,
    })
  })

  describe('"Select PDF area" in the + menu', function () {
    const openMenu = () =>
      fireEvent.click(screen.getByRole('button', { name: /add files or actions/i }))
    const item = () => screen.queryByRole('menuitem', { name: /pdf area/i })

    it('is hidden when the PDF viewer is not available', function () {
      publishPdfViewer(null)
      renderComposer()
      openMenu()
      expect(item()).to.be.null
    })

    it('is hidden when the AI assistant is disabled', function () {
      window.metaAttributesCache = new Map([['ol-aiAssistEnabled', false]])
      renderComposer()
      openMenu()
      expect(item()).to.be.null
    })

    it('sits right under "Add files or photos"', function () {
      renderComposer()
      openMenu()
      const items = screen.getAllByRole('menuitem').map(el => el.textContent)
      expect(items[0]).to.include('Add files or photos')
      expect(items[1]).to.equal('Select PDF area')
    })

    it('starts and cancels a box selection', function () {
      renderComposer()
      openMenu()
      expect(item()!.getAttribute('title')).to.equal(
        'Draw a box on the PDF to send that part to the AI'
      )
      fireEvent.click(item()!)
      expect(screen.getByRole('status').textContent).to.equal(
        'Drag a box on the PDF · Esc to cancel'
      )

      openMenu()
      expect(item()!.textContent).to.include('Cancel PDF area')
      expect(item()!.getAttribute('aria-pressed')).to.equal('true')
      fireEvent.click(item()!)
      expect(screen.queryByRole('status')).to.be.null
    })

    it('cancels a box selection on Esc without clearing the input', function () {
      renderComposer()
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'keep me' } })
      setPdf({ boxSelecting: true })

      fireEvent.keyDown(textarea, { key: 'Escape' })

      expect(screen.queryByRole('status')).to.be.null
      expect(textarea.value).to.equal('keep me')
    })

    it('cancels a box selection on Esc pressed outside the input', function () {
      renderComposer()
      setPdf({ boxSelecting: true })
      expect(screen.getByRole('status')).to.exist

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.queryByRole('status')).to.be.null
    })
  })

  describe('chips inside the composer', function () {
    /** The chip whose label reads `text`, as the user sees it. */
    const chip = (text: string) =>
      Array.from(document.querySelectorAll('.ai-assist-selection-chip')).find(
        el =>
          el.querySelector('.ai-assist-selection-chip-label')?.textContent ===
          text
      ) as HTMLElement | undefined

    it('renders a PDF selection chip in the chip row inside the box', function () {
      renderComposer()
      setPdf({ selections: [{ page: 2, text: 'hello  world' }] })

      const row = chip('PDF p.2: "hello world"')?.closest(
        '.ai-assist-selection-chip-wrapper'
      )
      expect(row).to.exist
      expect(row?.closest('.ai-assist-composer-box')).to.exist
    })

    it('keeps every selection and area the user adds', function () {
      renderComposer()
      setPdf({
        selections: [
          { page: 1, text: 'first' },
          { page: 4, text: 'second' },
        ],
        areas: [AREA, { ...AREA, page: 5, source: null }],
      })

      expect(chip('PDF p.1: "first"')).to.exist
      expect(chip('PDF p.4: "second"')).to.exist
      expect(chip('PDF p.3 area: main.tex:4-9')).to.exist
      expect(chip('PDF p.5 area')).to.exist
    })

    it('renders the chip row with only a PDF area and no other items', function () {
      const { container } = renderComposer()
      setPdf({ areas: [AREA] })

      expect(
        container.querySelector('.ai-assist-selection-chip-wrapper')
      ).to.exist
      expect(chip('PDF p.3 area: main.tex:4-9')).to.exist
    })

    it('shows the area picture as a thumbnail in the icon slot', function () {
      renderComposer()
      setPdf({ areas: [AREA] })

      const thumb = chip('PDF p.3 area: main.tex:4-9')?.querySelector(
        '.ai-assist-selection-chip-icon .ai-assist-selection-chip-thumb'
      ) as HTMLImageElement
      expect(thumb).to.exist
      expect(thumb.getAttribute('src')).to.equal(
        'data:image/png;base64,AAAA'
      )
    })

    it('labels an area without a source by its page only', function () {
      renderComposer()
      setPdf({ areas: [{ ...AREA, source: null, image: null }] })

      expect(chip('PDF p.3 area')).to.exist
      expect(screen.queryByText(/main\.tex/)).to.be.null
    })

    it('shows a capturing chip per box still being captured', function () {
      renderComposer()
      setPdf({ pendingAreas: 2 })

      const pending = document.querySelectorAll('.ai-assist-pdf-pending-chip')
      expect(pending).to.have.length(2)
      expect(chip('PDF area: capturing…')).to.exist
      expect(chip('PDF area: capturing…')?.querySelector('button')).to.be.null
    })

    it('removes only the PDF area whose remove button is pressed', function () {
      renderComposer()
      setPdf({ areas: [AREA, { ...AREA, page: 5, source: null }] })

      fireEvent.click(
        chip('PDF p.3 area: main.tex:4-9')!.querySelector('button')!
      )

      expect(chip('PDF p.3 area: main.tex:4-9')).to.be.undefined
      expect(chip('PDF p.5 area')).to.exist
    })

    it('removes the last item and the empty row with it', function () {
      renderComposer()
      setPdf({ areas: [AREA] })

      fireEvent.click(
        chip('PDF p.3 area: main.tex:4-9')!.querySelector('button')!
      )

      expect(
        document.querySelector('.ai-assist-selection-chip-wrapper')
      ).to.be.null
    })
  })

  describe('sending', function () {
    it('sends a PDF area with empty text', function () {
      const { onSend } = renderComposer()
      setPdf({ areas: [AREA] })

      const sendBtn = screen.getByRole('button', { name: /^send$/i })
      expect(sendBtn.hasAttribute('disabled')).to.be.false
      fireEvent.click(sendBtn)

      expect(onSend).to.have.been.calledOnce
      expect(onSend.lastCall.args[0]).to.equal('')
    })

    it('sends a PDF selection with empty text', function () {
      const { onSend } = renderComposer()
      setPdf({ selections: [{ page: 1, text: 'quoted' }] })

      fireEvent.click(screen.getByRole('button', { name: /^send$/i }))

      expect(onSend).to.have.been.calledOnce
    })

    it('does not send when only a capture is pending', function () {
      const { onSend } = renderComposer()
      setPdf({ pendingAreas: 1 })

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'Enter' })

      expect(onSend).not.to.have.been.called
    })
  })
})
