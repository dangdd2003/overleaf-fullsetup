import { expect } from 'chai'
import sinon from 'sinon'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  GeneratorDialog,
  GeneratorDialogProps,
  GeneratorDialogText,
} from '../../../../frontend/js/features/ai-assist/components/generator/generator-dialog'
import { spreadsheetText } from '../../../../frontend/js/features/ai-assist/generator/clipboard'

const TEXT: GeneratorDialogText = {
  title: 'Generate thing',
  lead: 'Lead:',
  placeholder: 'Describe it',
  promptLabel: 'Describe',
  dropText: 'Drop it here',
  imageAlt: 'The image',
}

function Harness(props: Partial<GeneratorDialogProps>) {
  const [prompt, setPrompt] = useState(props.prompt ?? '')
  return (
    <GeneratorDialog
      text={TEXT}
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
      prompt={prompt}
      onPrompt={setPrompt}
    />
  )
}

const imageItem = (file: File) => ({ kind: 'file', type: 'image/png', getAsFile: () => file })

/** What Excel puts on the clipboard: the cells as text and as a picture. */
function excelClipboard(file: File) {
  return {
    items: [imageItem(file)],
    files: [file],
    getData: (type: string) => (type === 'text/plain' ? 'a\tb\n1\t2' : ''),
  }
}

describe('generator: dialog', function () {
  afterEach(function () {
    cleanup()
  })

  it('shows a note and generates without words when allowed', function () {
    render(<Harness note="Uses the selected text (3 lines)" canGenerateEmpty />)
    expect(screen.getByText('Uses the selected text (3 lines)')).to.exist
    const generate = screen.getByRole('button', { name: /Generate/ }) as HTMLButtonElement
    expect(generate.disabled).to.equal(false)
  })

  it('leaves copied cells to the prompt box as text, not an image', function () {
    const onImageFile = sinon.spy()
    render(<Harness onImageFile={onImageFile} pasteText={spreadsheetText} />)
    const file = new File(['x'], 'cells.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText('Describe it'), {
      clipboardData: excelClipboard(file),
    })
    expect(onImageFile.called).to.equal(false)
  })

  it('appends copied cells to the prompt when pasted elsewhere in the dialog', function () {
    const onImageFile = sinon.spy()
    render(<Harness prompt="Make a table:" onImageFile={onImageFile} pasteText={spreadsheetText} />)
    const file = new File(['x'], 'cells.png', { type: 'image/png' })
    fireEvent.paste(screen.getByText('Drop it here'), { clipboardData: excelClipboard(file) })
    expect(onImageFile.called).to.equal(false)
    expect((screen.getByPlaceholderText('Describe it') as HTMLTextAreaElement).value).to.equal(
      'Make a table:\na\tb\n1\t2'
    )
  })

  it('still takes an image when the clipboard holds no cells', function () {
    const onImageFile = sinon.spy()
    render(<Harness onImageFile={onImageFile} pasteText={spreadsheetText} />)
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText('Describe it'), {
      clipboardData: { items: [imageItem(file)], files: [file], getData: () => '' },
    })
    expect(onImageFile.calledWith(file)).to.equal(true)
  })
})
