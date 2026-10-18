import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'

describe('system prompt PDF sections', function () {
  it('includes the highlight tool instructions', function () {
    expect(SYSTEM_PROMPT).to.contain('highlight_in_pdf')
  })

  it('describes the PDF context tags', function () {
    for (const tag of ['<pdf-viewer', '<pdf-selection', '<pdf-area']) {
      expect(SYSTEM_PROMPT).to.contain(tag)
    }
  })

  it('tells the model the area crop is the attached image, and where its source is', function () {
    expect(SYSTEM_PROMPT).to.contain('image="K"')
    expect(SYSTEM_PROMPT).to.match(/its crop is the Kth image on this message/)
    expect(SYSTEM_PROMPT).to.match(/there can be several/)
    expect(SYSTEM_PROMPT).to.match(/appear only when\s+it resolved/)
  })

  it('no longer mentions the double-click pointer', function () {
    expect(SYSTEM_PROMPT).to.not.contain('pdf-pointer')
    expect(SYSTEM_PROMPT.toLowerCase()).to.not.contain('double-click')
  })

  it('names only tools the frontend registry offers', function () {
    // read_file is offered; view_compiled_pdf_page is a server-side tool
    expect(SYSTEM_PROMPT).to.contain('`read_file`')
    expect(SYSTEM_PROMPT).to.not.contain('view_compiled_pdf_page')
  })
})
