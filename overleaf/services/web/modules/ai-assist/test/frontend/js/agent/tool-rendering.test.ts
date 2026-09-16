import { expect } from 'chai'
import { runAgent } from '../../../../frontend/js/features/ai-assist/agent/run-agent'
import { readFileTool } from '../../../../frontend/js/features/ai-assist/agent/tools/read-file'
import { compileProjectTool } from '../../../../frontend/js/features/ai-assist/agent/tools/compile-project'
import { createFakeHandle } from './helpers/fake-handle'

function fakeClient(turns: any[]) {
  const requests: any[] = []
  let turn = 0
  const client = {
    requests,
    async *streamChat(request: any) {
      requests.push({ ...request, messages: [...request.messages] })
      const chunks = turns[turn++] ?? [{ type: 'done', stopReason: 'stop' }]
      for (const chunk of chunks) yield chunk
    },
    async listModels() {
      return []
    },
  }
  return { client, requests }
}

describe('tool result rendering', function () {
  it('renders a read as fenced numbered text, not escaped JSON', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb' } })
    const result = await readFileTool.execute({ path: 'main.tex' }, handle)
    const rendered = readFileTool.render!(result)

    expect(rendered).to.include('main.tex')
    expect(rendered).to.include('1: a')
    expect(rendered).to.not.include('\\n')
  })

  it('says how to get the rest when a read was truncated', async function () {
    const lines = Array.from({ length: 1500 }, (_unused, index) => `l${index}`)
    const { handle } = createFakeHandle({ docs: { 'big.tex': lines.join('\n') } })
    const result = await readFileTool.execute({ path: 'big.tex' }, handle)

    expect(readFileTool.render!(result)).to.match(/read_file.*1001/)
  })

  it('renders an error result as JSON so the model can branch on it', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a' } })
    const result = await readFileTool.execute({ path: 'nope.tex' }, handle)

    expect(readFileTool.render!(result)).to.include('"error"')
  })

  it('leaves tools without a renderer alone', function () {
    expect(compileProjectTool.render).to.equal(undefined)
  })

  it('uses tool.render in runAgent when sending tool results', async function () {
    const { client, requests } = fakeClient([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    for await (const _event of runAgent({
      client: client as any,
      handle,
      tools: { read_file: readFileTool },
      transcript: [{ id: '1', role: 'user', text: 'go' }],
    })) {
      // consume
    }

    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).to.include('main.tex lines 1-1 of 1')
    expect(toolMsg.content).to.include('1: hello')
    expect(toolMsg.content).to.not.include('{"content"')
  })
})
