import { expect } from 'chai'
import {
  extractFencedToolCall,
  parseWholeMessageToolCall,
} from '../../../../frontend/js/features/ai-assist/agent/text-tool-call'

const TOOLS: any = {
  read_file: {
    spec: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
}

describe('extractFencedToolCall', function () {
  it('converts a complete fenced call and returns the surrounding text', function () {
    const pending = 'Let me look.\n```json\n{"name":"read_file","arguments":{"path":"main.tex"}}\n```\nDone.'
    const found = extractFencedToolCall(pending, TOOLS)
    expect(found).to.not.equal(null)
    expect(found!.call.id).to.match(/^call_txt_/)
    expect(found!.call.name).to.equal('read_file')
    expect(found!.call.args).to.deep.equal({ path: 'main.tex' })
    expect(found!.before).to.equal('Let me look.\n')
    expect(found!.after).to.equal('\nDone.')
  })

  it('returns null while the fence is still open', function () {
    const pending = '```json\n{"name":"read_file","arguments":{"path":"'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves prose that merely mentions json alone', function () {
    const pending = 'The config looks like ```json\n{"name": "read_file"}\n``` but is not a call.'
    // No "arguments" object that validates against the spec: not a call.
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves an unknown tool name as text', function () {
    const pending = '```json\n{"name":"vibes","arguments":{"path":"main.tex"}}\n```'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves invalid arguments as text', function () {
    const pending = '```json\n{"name":"read_file","arguments":{"nope":1}}\n```'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })
})

describe('parseWholeMessageToolCall', function () {
  it('converts a message that is only a tool call object', function () {
    const call = parseWholeMessageToolCall(
      '{"name":"read_file","arguments":{"path":"main.tex"}}',
      TOOLS
    )
    expect(call).to.not.equal(null)
    expect(call!.id).to.match(/^call_txt_/)
    expect(call!.name).to.equal('read_file')
    expect(call!.args).to.deep.equal({ path: 'main.tex' })
  })

  it('returns null for a message that is prose', function () {
    expect(parseWholeMessageToolCall('I will read the file now.', TOOLS)).to.equal(null)
  })
})
