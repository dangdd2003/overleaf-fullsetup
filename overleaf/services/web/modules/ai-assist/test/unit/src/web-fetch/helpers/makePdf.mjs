/**
 * A minimal valid PDF with one page per entry of `pages`; "\n" in a page
 * starts a new text line. `title` goes in the document info dictionary.
 */
export function makePdf(pages, title = '') {
  const escape = text => text.replace(/[\\()]/g, match => `\\${match}`)
  const objects = []
  const count = pages.length
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((text, i) => {
    const ops = text
      .split('\n')
      .map((line, j) => `${j === 0 ? '' : '0 -14 Td '}(${escape(line)}) Tj`)
      .join(' ')
    const stream = `BT /F1 12 Tf 72 720 Td ${ops} ET`
    objects[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`
    objects[5 + 2 * i] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })
  const infoId = 4 + 2 * count
  objects[infoId] = `<< /Title (${escape(title)}) >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let id = 1; id <= infoId; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1')
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${infoId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= infoId; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A line long enough that two pages of it clear the 100-character floor. */
export const PDF_LINE =
  'The siunitx package provides the qty command for physical quantities.'
