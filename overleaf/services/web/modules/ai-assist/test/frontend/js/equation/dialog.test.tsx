import { expect } from 'chai'
import sinon from 'sinon'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  EquationDialog,
  EquationDialogProps,
} from '../../../../frontend/js/features/ai-assist/components/equation/equation-dialog'
import { GeneratorImage } from '../../../../frontend/js/features/ai-assist/generator/image'

const IMAGE: GeneratorImage = {
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
  name: 'friedmann.png',
  size: 1258291,
  width: 800,
  height: 200,
}

function Harness(props: Partial<EquationDialogProps>) {
  const [prompt, setPrompt] = useState(props.prompt ?? '')
  return (
    <EquationDialog
      prompt={prompt}
      onPrompt={setPrompt}
      image={null}
      imageError={null}
      readingImage={false}
      imagesEnabled
      onImageFile={() => {}}
      onRemoveImage={() => {}}
      error={null}
      onGenerate={() => {}}
      onCancel={() => {}}
      {...props}
    />
  )
}

const generateButton = () => screen.getByRole('button', { name: /Generate/ }) as HTMLButtonElement
const promptBox = () => screen.getByPlaceholderText('Example: provide the Friedmann Equations')

describe('equation: dialog', function () {
  afterEach(function () {
    cleanup()
  })

  it('looks like the official dialog and needs text or an image', function () {
    render(<Harness />)
    expect(screen.getByText('Generate equation')).to.exist
    expect(screen.getByText('Enter your prompt or paste an image with the equation:')).to.exist
    expect(screen.getByText('Drop an image of the equation here')).to.exist
    expect(generateButton().disabled).to.equal(false ? false : true)
    fireEvent.change(promptBox(), { target: { value: 'the Friedmann equations' } })
    expect(generateButton().disabled).to.equal(false)
  })

  it('generates on Ctrl+Enter and cancels on Cancel', function () {
    const onGenerate = sinon.spy()
    const onCancel = sinon.spy()
    render(<Harness prompt="x" onGenerate={onGenerate} onCancel={onCancel} />)
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true })
    expect(onGenerate.calledOnce).to.equal(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel.calledOnce).to.equal(true)
  })

  it('takes a dropped or browsed image', function () {
    const onImageFile = sinon.spy()
    render(<Harness onImageFile={onImageFile} />)
    const file = new File(['x'], 'eq.png', { type: 'image/png' })
    fireEvent.drop(screen.getByText('Drop an image of the equation here'), {
      dataTransfer: { files: [file] },
    })
    expect(onImageFile.calledWith(file)).to.equal(true)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    expect(onImageFile.callCount).to.equal(2)
  })

  it('takes an image pasted into the prompt box', function () {
    const onImageFile = sinon.spy()
    render(<Harness onImageFile={onImageFile} />)
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    fireEvent.paste(promptBox(), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        files: [file],
      },
    })
    expect(onImageFile.calledWith(file)).to.equal(true)
  })

  it('ignores images while they are not enabled', function () {
    const onImageFile = sinon.spy()
    render(<Harness imagesEnabled={false} onImageFile={onImageFile} />)
    const zone = screen.getByText('Drop an image of the equation here').closest('.ai-generator-image')!
    expect(zone.getAttribute('aria-disabled')).to.equal('true')
    expect(zone.getAttribute('title')).to.equal('Images are coming soon')
    const file = new File(['x'], 'eq.png', { type: 'image/png' })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    fireEvent.paste(promptBox(), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] },
    })
    expect(onImageFile.called).to.equal(false)
  })

  it('shows the image, lets it be removed, and generates from it alone', function () {
    const onRemoveImage = sinon.spy()
    render(<Harness image={IMAGE} onRemoveImage={onRemoveImage} />)
    expect(screen.getByText('friedmann.png')).to.exist
    expect(screen.getByText('1.2 MB')).to.exist
    expect(generateButton().disabled).to.equal(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(onRemoveImage.calledOnce).to.equal(true)
  })

  it('explains a refused image and a refused place', function () {
    render(<Harness imageError="size" error="Can't insert math here" />)
    expect(screen.getByText("Images over 20 MB can't be used")).to.exist
    expect(screen.getByText("Can't insert math here")).to.exist
  })
})
