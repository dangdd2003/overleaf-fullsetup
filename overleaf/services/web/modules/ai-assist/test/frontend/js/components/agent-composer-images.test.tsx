import { expect } from 'chai'
import sinon from 'sinon'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AgentComposer } from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'
import * as imageUtils from '../../../../frontend/js/features/ai-assist/generator/image'

const PATHS = ['main.tex', 'sections/results.tex', 'refs.bib']

function renderComposer(
  overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}
) {
  const onSend = sinon.stub()
  const onStop = sinon.stub()
  const utils = render(
    <AgentComposer
      running={false}
      paths={PATHS}
      onSend={onSend}
      onStop={onStop}
      {...overrides}
    />
  )
  return { ...utils, onSend, onStop }
}

describe('AgentComposer image attachments and plus menu', function () {
  let normalizeStub: sinon.SinonStub

  beforeEach(function () {
    normalizeStub = sinon
      .stub(imageUtils, 'normalizeImage')
      .callsFake(async (file: File) => ({
        mediaType: 'image/png',
        data: 'base64fakeimagedata',
        name: file.name || 'test-image.png',
        size: file.size || 2048,
        width: 400,
        height: 300,
      }))
  })

  afterEach(function () {
    sinon.restore()
  })

  it('opens the plus menu when clicking the + button', function () {
    renderComposer()
    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })
    expect(plusBtn).to.exist
    expect(screen.queryByRole('menu')).to.be.null

    fireEvent.click(plusBtn)
    expect(screen.getByRole('menu')).to.exist
    expect(screen.getByText('Add files or photos')).to.exist
    expect(screen.getByText('Slash commands')).to.exist
  })

  it('clicking + does NOT open workspace project files', function () {
    renderComposer()
    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })
    fireEvent.click(plusBtn)

    expect(screen.getByRole('menu')).to.exist
    expect(screen.queryByRole('listbox')).to.be.null
    expect(screen.queryByRole('option', { name: /main\.tex/ })).to.be.null
  })

  it('clicking "Add files or photos" in plus menu triggers the hidden file input click', function () {
    renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    expect(fileInput).to.exist
    const clickSpy = sinon.spy(fileInput, 'click')

    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })
    fireEvent.click(plusBtn)

    const addFilesItem = screen.getByText('Add files or photos').closest('button')!
    fireEvent.click(addFilesItem)

    expect(clickSpy).to.have.been.calledOnce
    expect(screen.queryByRole('menu')).to.be.null
  })

  it('pressing Ctrl+U or Cmd+U triggers the file input click', function () {
    renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    expect(fileInput).to.exist
    const clickSpy = sinon.spy(fileInput, 'click')
    const textarea = screen.getByRole('textbox')

    // Ctrl+U
    fireEvent.keyDown(textarea, { key: 'u', ctrlKey: true })
    expect(clickSpy).to.have.been.calledOnce

    // Cmd+U (metaKey)
    fireEvent.keyDown(textarea, { key: 'U', metaKey: true })
    expect(clickSpy).to.have.been.calledTwice
  })

  it('selecting files via file input populates image preview chip', async function () {
    renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    const file = new File(['fake-png-data'], 'figure1.png', {
      type: 'image/png',
    })

    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      const chip = document.querySelector('.ai-assist-image-chip')
      expect(chip).to.exist
      expect(screen.getByText(/figure1\.png/)).to.exist
      const img = chip?.querySelector('img')
      expect(img).to.exist
      expect(img?.getAttribute('src')).to.equal(
        'data:image/png;base64,base64fakeimagedata'
      )
    })
  })

  it('paste event with image file populates image preview chip', async function () {
    renderComposer()
    const textarea = screen.getByRole('textbox')
    const file = new File(['fake-png-data'], 'screenshot.png', {
      type: 'image/png',
    })
    const clipboardData = {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        },
      ],
      files: [file],
    }

    fireEvent.paste(textarea, { clipboardData })

    await waitFor(() => {
      const chip = document.querySelector('.ai-assist-image-chip')
      expect(chip).to.exist
      expect(screen.getByText(/screenshot\.png/)).to.exist
    })
  })

  it('drag and drop image file onto composer box populates image preview chip and handles drag-over class', async function () {
    renderComposer()
    const composerBox = document.querySelector('.ai-assist-composer-box')!
    expect(composerBox).to.exist

    // Drag over
    fireEvent.dragOver(composerBox)
    expect(composerBox.classList.contains('is-drag-over')).to.be.true

    // Drag leave
    fireEvent.dragLeave(composerBox)
    expect(composerBox.classList.contains('is-drag-over')).to.be.false

    // Drag over then drop
    fireEvent.dragOver(composerBox)
    const file = new File(['fake-png-data'], 'dropped.png', {
      type: 'image/png',
    })
    fireEvent.drop(composerBox, {
      dataTransfer: {
        files: [file],
      },
    })

    expect(composerBox.classList.contains('is-drag-over')).to.be.false
    await waitFor(() => {
      const chip = document.querySelector('.ai-assist-image-chip')
      expect(chip).to.exist
      expect(screen.getByText(/dropped\.png/)).to.exist
    })
  })

  it('enforces a maximum of 2 images', async function () {
    renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement

    const f1 = new File(['1'], 'img1.png', { type: 'image/png' })
    const f2 = new File(['2'], 'img2.png', { type: 'image/png' })
    const f3 = new File(['3'], 'img3.png', { type: 'image/png' })

    fireEvent.change(fileInput, { target: { files: [f1, f2, f3] } })

    await waitFor(() => {
      const chips = document.querySelectorAll('.ai-assist-image-chip')
      expect(chips.length).to.equal(2)
      expect(screen.getByText(/img1\.png/)).to.exist
      expect(screen.getByText(/img2\.png/)).to.exist
      expect(screen.queryByText(/img3\.png/)).to.be.null
    })
  })

  it('clicking remove on image chip deletes the image', async function () {
    renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    const file = new File(['fake-png-data'], 'delete-me.png', {
      type: 'image/png',
    })

    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText(/delete-me\.png/)).to.exist
    })

    const removeBtn = screen.getByRole('button', { name: /remove image/i })
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(screen.queryByText(/delete-me\.png/)).to.be.null
      expect(document.querySelector('.ai-assist-image-chip')).to.be.null
    })
  })

  it('sending message with image passes images to onSend and resets images state', async function () {
    const { onSend } = renderComposer()
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    const file = new File(['fake-png-data'], 'plot.png', {
      type: 'image/png',
    })

    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText(/plot\.png/)).to.exist
    })

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Analyze this plot' } })

    const sendBtn = screen.getByRole('button', { name: /send/i })
    fireEvent.click(sendBtn)

    expect(onSend).to.have.been.calledOnce
    expect(onSend.lastCall.args[0]).to.equal('Analyze this plot')
    expect(onSend.lastCall.args[1]).to.deep.equal([])
    expect(onSend.lastCall.args[2]).to.be.null
    expect(onSend.lastCall.args[3]).to.be.undefined
    expect(onSend.lastCall.args[4]).to.deep.equal([
      {
        mediaType: 'image/png',
        data: 'base64fakeimagedata',
      },
    ])

    // Images cleared after sending
    await waitFor(() => {
      expect(document.querySelector('.ai-assist-image-chip')).to.be.null
    })
  })

  it('clicking "Slash commands" in plus menu types / and opens slash menu', async function () {
    renderComposer()
    const plusBtn = screen.getByRole('button', {
      name: /add files or actions/i,
    })
    fireEvent.click(plusBtn)

    const slashItem = screen.getByText('Slash commands').closest('button')!
    fireEvent.click(slashItem)

    // Plus menu closed
    expect(screen.queryByRole('menu')).to.be.null

    // Textarea value has '/'
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).to.equal('/')

    // Slash menu opened
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: /commands/i })).to.exist
    })
  })
})
