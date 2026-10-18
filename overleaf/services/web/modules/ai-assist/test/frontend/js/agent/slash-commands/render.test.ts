import { expect } from 'chai'
import { renderCommandBlock } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/render'
import { SLASH_HARNESS } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/harness'
import { slashCommandById } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'

function command(id: Parameters<typeof slashCommandById>[0]) {
  const definition = slashCommandById(id)
  if (!definition) throw new Error(`no command ${id}`)
  return definition
}

describe('renderCommandBlock', function () {
  it('renders the name, scope, harness and params, with no gathered section when nothing was gathered', function () {
    const block = renderCommandBlock({ command: command('explain'), gathered: [] })
    expect(block).to.equal(
      [
        '<command name="explain" scope="read">',
        '<instructions>',
        SLASH_HARNESS.explain,
        '</instructions>',
        '<params>',
        'notes: none (the selection, else the lines at the cursor)',
        '</params>',
        '</command>',
      ].join('\n')
    )
  })

  it('puts the params read from the words between the harness and the gathered context', function () {
    const block = renderCommandBlock({
      command: command('rewrite'),
      args: 'formal concise 30% keep the last sentence',
      gathered: ['<section>\nx\n</section>'],
    })
    expect(block).to.include(
      [
        '</instructions>',
        '<params>',
        'style: formal, concise',
        'length: 30% shorter',
        'notes: keep the last sentence',
        '</params>',
        '<gathered>',
      ].join('\n')
    )
  })

  it('wraps the gathered blocks in <gathered>, in the order given', function () {
    const block = renderCommandBlock({
      command: command('fix'),
      gathered: ['<compile-log>\nA\n</compile-log>', '<preamble file="main.tex" lines="1-1">\n1: x\n</preamble>'],
    })
    expect(block).to.equal(
      [
        '<command name="fix" scope="edit">',
        '<instructions>',
        SLASH_HARNESS.fix,
        '</instructions>',
        '<params>',
        'scope: none (the first error, plus any error with the same cause)',
        'location: none (where the first error points)',
        'notes: none',
        '</params>',
        '<gathered>',
        '<compile-log>\nA\n</compile-log>\n<preamble file="main.tex" lines="1-1">\n1: x\n</preamble>',
        '</gathered>',
        '</command>',
      ].join('\n')
    )
  })

  it('takes its scope from the command, so a read command says read', function () {
    expect(renderCommandBlock({ command: command('explain'), gathered: [] })).to.include(
      '<command name="explain" scope="read">'
    )
    expect(renderCommandBlock({ command: command('fix'), gathered: [] })).to.include(
      '<command name="fix" scope="edit">'
    )
  })

  it('does not re-escape gathered text, which the renderers already escaped', function () {
    const gathered = '<source file="main.tex" lines="1-1">\n1: a & b < c\n</source>'
    const block = renderCommandBlock({ command: command('rewrite'), gathered: [gathered] })
    expect(block).to.include(gathered)
  })

  it('is a pure function: the same input gives the same bytes', function () {
    const input = {
      command: command('rewrite'),
      args: 'concise 30%',
      gathered: ['<labels>\nx\n</labels>'],
    }
    expect(renderCommandBlock(input)).to.equal(renderCommandBlock(input))
  })
})
