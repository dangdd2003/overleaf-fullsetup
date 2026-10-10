import { expect } from 'chai'
import {
  buildTableFollowUp,
  buildTableMessage,
  buildTableRepair,
  buildTableRetry,
  TABLE_SYSTEM,
  TableRequest,
} from '../../../../frontend/js/features/ai-assist/table/prompt'

const REQUEST: TableRequest = {
  docClass: 'article',
  language: 'english',
  packages: ['booktabs', 'amsmath'],
  macros: ['\\R'],
  habits: { labelStyle: 'tab:', rules: 'booktabs', vlines: false, envs: '', twoColumn: false },
  before: 'We trained three models.\n',
  after: '\nAs the table shows…',
  where: { kind: 'float' },
  selection: null,
  imageAttached: false,
  prompt: 'accuracy of A, B and C',
}

describe('table: prompt', function () {
  it('keeps the system prompt constant and complete', function () {
    expect(TABLE_SYSTEM).to.include('Keep every given value exactly')
    expect(TABLE_SYSTEM).to.include(
      '<table env="tabular|tabularx" spec="…" label="…" wide="false" float="true">'
    )
    expect(TABLE_SYSTEM).to.include('Announced image you cannot see: <cannot>no-image</cannot>')
    expect(TABLE_SYSTEM).to.include('every row ending with \\\\.')
  })

  it('decides the content in order and shows one example reply', function () {
    for (const phrase of [
      '# Step 1: the content (the first rule that applies)',
      '3. A selection of kind="table": the same cells, changed only as the request asks.',
      'Vertical lines only when vlines="yes"',
      '<caption>Accuracy of models A and B.</caption>',
      'A & 91.20 \\\\',
    ]) {
      expect(TABLE_SYSTEM).to.include(phrase)
    }
  })

  it('puts the data first and the request last', function () {
    expect(buildTableMessage(REQUEST)).to.equal(
      [
        '<document class="article" language="english" packages="booktabs amsmath" macros="\\R" columns="1" label_style="tab:" rules="booktabs" vlines="no" />',
        '<context_before>\nWe trained three models.\n\n</context_before>',
        '<where kind="float" />',
        '<context_after>\n\nAs the table shows…\n</context_after>',
        '<request>\naccuracy of A, B and C\n</request>',
      ].join('\n\n')
    )
  })

  it('describes an inner place, a selection and an image', function () {
    const message = buildTableMessage({
      ...REQUEST,
      before: '',
      after: '',
      where: { kind: 'inner', hasCaption: true },
      selection: { kind: 'data', text: 'a\tb\n1\t2' },
      imageAttached: true,
      prompt: '',
      habits: { ...REQUEST.habits, twoColumn: true, envs: 'tabular:2' },
    })
    expect(message).to.include('columns="2"')
    expect(message).to.include('envs="tabular:2"')
    expect(message).to.include(
      '<where kind="inner" caption="yes" />\n\n<selection kind="data">\na\tb\n1\t2\n</selection>'
    )
    expect(message.endsWith('<image attached="true" />\n\n<request>\n\n</request>')).to.equal(true)
  })

  it('asks for changes, another layout, or a fix', function () {
    expect(buildTableFollowUp('merge the first two columns')).to.equal(
      '<request>\nmerge the first two columns\n</request>\nChange your last reply as asked. Reply in the same format, with the whole table.'
    )
    expect(buildTableRetry(['T1'])).to.equal(
      '<previous_attempts>\n<attempt>\nT1\n</attempt>\n</previous_attempts>\nAnswer again with the same values and a noticeably different layout (header, alignment, grouping, rules or width), in the same format. From an image, also reconsider the cells you were unsure of.'
    )
    expect(buildTableRepair(['Row 1 has 3 cells but the spec has 2 columns.'])).to.equal(
      '<problems>\n- Row 1 has 3 cells but the spec has 2 columns.\n</problems>\nReply again in the same format, fixing every problem.'
    )
  })
})
