import { expect } from 'chai'
import { buildRequest } from '../../../../../frontend/js/features/ai-assist/agent/context/build-request'
import { TranscriptEntry } from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'
import { renderCommandBlock } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/render'
import { slashCommandById } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'
import { TOOLS } from '../../../../../frontend/js/features/ai-assist/agent/tools/registry'

// The provider's cached prefix is the tools, the system prompt and every
// earlier message. A slash command must not move any of them: these tests pin
// that a command turn is the plain turn with a different last user message.

const limits = { contextWindow: 128000, maxOutputTokens: 8192 }
const tools = Object.values(TOOLS).map(tool => tool.spec)

const turnOne: TranscriptEntry[] = [
  {
    id: 'u1',
    role: 'user',
    text: 'why does this not build?',
    contextText: '<project-context turn="1">\n<files>main.tex</files>\n</project-context>',
  },
  {
    id: 'a1',
    role: 'assistant',
    text: 'Let me look.',
    toolCalls: [
      { id: 'c1', name: 'read_file', args: { path: 'main.tex' }, result: { content: '1: hi' } },
    ],
  },
]

const contextTwo =
  '<project-context turn="2">\n<files>unchanged since turn 1</files>\n</project-context>'

const plainTurnTwo: TranscriptEntry[] = [
  ...turnOne,
  {
    id: 'u2',
    role: 'user',
    text: 'and now?',
    contextText: contextTwo,
  },
]

const fix = slashCommandById('fix')
if (!fix) throw new Error('fix is not a command')

const commandTurnTwo: TranscriptEntry[] = [
  ...turnOne,
  {
    id: 'u2',
    role: 'user',
    text: 'the table',
    contextText: contextTwo,
    command: { id: 'fix', args: 'the table' },
    commandText: renderCommandBlock({
      command: fix,
      gathered: [
        '<preamble file="main.tex" lines="1-2">\n1: \\documentclass{article}\n2: \\usepackage{graphicx}\n</preamble>',
      ],
    }),
  },
]

describe('slash commands and the provider cache', function () {
  it('leaves the system prompt identical to a plain turn', function () {
    const plain = buildRequest({ transcript: plainTurnTwo, limits, tools })
    const command = buildRequest({ transcript: commandTurnTwo, limits, tools })
    expect(command.system).to.equal(plain.system)
  })

  it('leaves the cache hints identical to a plain turn', function () {
    const plain = buildRequest({ transcript: plainTurnTwo, limits, tools })
    const command = buildRequest({ transcript: commandTurnTwo, limits, tools })
    expect(command.cacheHints).to.deep.equal(plain.cacheHints)
  })

  it('sends turn one as an exact prefix of a command turn two', function () {
    const first = buildRequest({ transcript: turnOne, limits, tools }).messages
    const second = buildRequest({ transcript: commandTurnTwo, limits, tools })
      .messages
    expect(second.slice(0, first.length)).to.deep.equal(first)
  })

  it('differs from the plain turn only in the last user message', function () {
    const plain = buildRequest({ transcript: plainTurnTwo, limits, tools }).messages
    const command = buildRequest({ transcript: commandTurnTwo, limits, tools })
      .messages
    expect(command).to.have.length(plain.length)
    expect(command.slice(0, -1)).to.deep.equal(plain.slice(0, -1))
    expect(command.at(-1)?.role).to.equal('user')
    expect(command.at(-1)?.content).not.to.equal(plain.at(-1)?.content)
  })

  it('puts the command block after the context and before the words', function () {
    const { messages } = buildRequest({ transcript: commandTurnTwo, limits, tools })
    const content = messages.at(-1)?.content as string
    expect(content.startsWith(`${contextTwo}\n\n<command name="fix" scope="edit">`)).to.equal(true)
    expect(content.endsWith('\n\nthe table')).to.equal(true)
  })

  it('rebuilding the same stored transcript reproduces the same bytes', function () {
    const once = buildRequest({ transcript: commandTurnTwo, limits, tools })
    const again = buildRequest({ transcript: commandTurnTwo, limits, tools })
    expect(again.messages).to.deep.equal(once.messages)
  })
})
