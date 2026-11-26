import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import { FIX_SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/fix-system-prompt'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

// The PDF guidance (highlight_in_pdf, the pdf-viewer, pdf-selection and
// pdf-area tags) lives in the server prompt, which the panel's runs use. The
// in-browser default is a short fallback, and the fix run offers no PDF tool,
// so neither describes the PDF.
describe('system prompt PDF sections', function () {
  it('leaves the PDF guidance to the server prompt', function () {
    for (const prompt of [SYSTEM_PROMPT, FIX_SYSTEM_PROMPT]) {
      expect(prompt).to.not.contain('highlight_in_pdf')
      expect(prompt).to.not.contain('<pdf-')
    }
  })

  it('no longer mentions the double-click pointer', function () {
    expect(SYSTEM_PROMPT).to.not.contain('pdf-pointer')
    expect(SYSTEM_PROMPT.toLowerCase()).to.not.contain('double-click')
  })

  it('names only tools the frontend registry offers', function () {
    // view_compiled_pdf_page is a server-side tool
    for (const prompt of [SYSTEM_PROMPT, FIX_SYSTEM_PROMPT]) {
      expect(prompt).to.not.contain('view_compiled_pdf_page')
      const named = (prompt.match(/`([a-z_]+)`/g) ?? []).map(m =>
        m.replace(/`/g, '')
      )
      for (const name of named) {
        if (/^(get|list|read|search|compile|edit|create)_/.test(name)) {
          expect(TOOLS, `prompt names ${name}`).to.have.property(name)
        }
      }
    }
  })
})
