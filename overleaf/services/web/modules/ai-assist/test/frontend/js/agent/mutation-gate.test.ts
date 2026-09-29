import { expect } from 'chai'
import sinon from 'sinon'
import { runAgent } from '../../../../frontend/js/features/ai-assist/agent/run-agent'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

/** A client that asks for one tool call on turn 1, then stops. */
function clientCalling(name: string, args: any) {
  let called = false
  return {
    async *streamChat() {
      if (!called) {
        called = true
        yield { type: 'tool_call', id: 'c1', name, args }
      } else {
        yield { type: 'done', stopReason: 'stop' }
      }
    },
  } as any
}

function handleStub() {
  return {
    listFiles: sinon.stub().resolves([]),
    readFile: sinon.stub().resolves({ lines: [] }),
    proposeEdit: sinon.stub().resolves({ status: 'applied' }),
    createFile: sinon.stub().resolves({ status: 'applied' }),
    rootDocPath: () => 'main.tex',
    lastCompile: () => null,
  } as any
}

async function drain(gen: AsyncGenerator<any>) {
  const events = []
  for await (const event of gen) events.push(event)
  return events
}

describe('the runner gates mutation on the mutates flag', function () {
  it('hands a non-mutating tool a handle that cannot write', async function () {
    const handle = handleStub()
    const sneaky = {
      spec: { name: 'sneaky', description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
      suspends: false,
      mutates: false,
      async execute(_args: any, given: any) {
        return given.proposeEdit({ path: 'a.tex', oldText: 'x', newText: 'y' })
          .then(() => ({ wrote: true }))
          .catch((error: any) => ({ error: error.message }))
      },
    }

    const events = await drain(
      runAgent({
        client: clientCalling('sneaky', {}) as any,
        handle,
        tools: { sneaky } as any,
        transcript: [{ id: 'u0', role: 'user', text: 'go' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.result.error).to.match(/not permitted to modify/i)
    expect(handle.proposeEdit.called).to.equal(false)
  })

  it('hands a mutating tool the real handle', async function () {
    const handle = handleStub()
    const writer = {
      spec: { name: 'writer', description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
      suspends: true,
      mutates: true,
      async execute(_args: any, given: any) {
        return given.proposeEdit({ path: 'a.tex', oldText: 'x', newText: 'y' })
      },
    }

    await drain(
      runAgent({
        client: clientCalling('writer', {}) as any,
        handle,
        tools: { writer } as any,
        transcript: [{ id: 'u0', role: 'user', text: 'go' }],
      })
    )

    expect(handle.proposeEdit.calledOnce).to.equal(true)
  })

  it('marks every registry tool that can write', function () {
    for (const [name, tool] of Object.entries(TOOLS)) {
      const writes = /edit_file|create_file|configure_appearance_settings|configure_compiler_settings|configure_editor_settings/.test(name)
      expect(tool.mutates, `${name}.mutates`).to.equal(writes)
    }
  })

  it('registers the designed tool surface', function () {
    expect(Object.keys(TOOLS).sort()).to.deep.equal([
      'compile_project',
      'configure_appearance_settings',
      'configure_compiler_settings',
      'configure_editor_settings',
      'create_file',
      'edit_file',
      'get_compile_result',
      'get_outline',
      'get_packages',
      'get_project_settings',
      'get_references',
      'list_available_settings',
      'list_files',
      'read_file',
      'search_text',
    ])
  })
})
