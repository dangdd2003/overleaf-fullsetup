import { expect } from 'chai'
import sinon from 'sinon'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  TableDialog,
  TableDialogProps,
} from '../../../../frontend/js/features/ai-assist/components/table/table-dialog'

const PLACEHOLDER =
  'Example: create a table with 6 rows and 6 columns, centered, with a horizontal line after the heading'

function Harness(props: Partial<TableDialogProps>) {
  const [prompt, setPrompt] = useState(props.prompt ?? '')
  return (
    <TableDialog
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
      selectionLines={0}
      {...props}
    />
  )
}

const generateButton = () => screen.getByRole('button', { name: /Generate/ }) as HTMLButtonElement

describe('table: dialog', function () {
  afterEach(function () {
    cleanup()
  })

  it('looks like the official dialog', function () {
    render(<Harness />)
    expect(screen.getByText('Generate table')).to.exist
    expect(screen.getByText('Enter your prompt or paste an image with the table:')).to.exist
    expect(screen.getByPlaceholderText(PLACEHOLDER)).to.exist
    expect(screen.getByText('Drop an image of the table here')).to.exist
    expect(generateButton().disabled).to.equal(true)
  })

  it('generates from a selection alone and says so', function () {
    render(<Harness selectionLines={3} />)
    expect(screen.getByText('Uses the selected text (3 lines)')).to.exist
    expect(generateButton().disabled).to.equal(false)
  })

  it('takes cells pasted from a spreadsheet as text, not as their picture', function () {
    const onImageFile = sinon.spy()
    render(<Harness onImageFile={onImageFile} />)
    const file = new File(['x'], 'cells.png', { type: 'image/png' })
    fireEvent.paste(screen.getByText('Drop an image of the table here'), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        files: [file],
        getData: (type: string) => (type === 'text/plain' ? 'Model\tAcc.\nA\t0.91' : ''),
      },
    })
    expect(onImageFile.called).to.equal(false)
    expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value).to.equal(
      'Model\tAcc.\nA\t0.91'
    )
  })
})
