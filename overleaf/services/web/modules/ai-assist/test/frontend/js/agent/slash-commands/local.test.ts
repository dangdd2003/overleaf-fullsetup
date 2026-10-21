import { expect } from 'chai'
import {
  LOCAL_SLASH_COMMANDS,
  filterLocalSlashCommands,
  findLocalSlashCommand,
  parseLocalSlashInput,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/local'
import {
  SLASH_COMMANDS,
  parseSlashInput,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'

describe('local slash commands', function () {
  it('has /context, reachable by its aliases', function () {
    expect(LOCAL_SLASH_COMMANDS.map(c => c.id)).to.deep.equal([
      'context',
      'compact',
    ])
    expect(findLocalSlashCommand('context')?.id).to.equal('context')
    expect(findLocalSlashCommand('usage')?.id).to.equal('context')
    expect(findLocalSlashCommand('TOKENS')?.id).to.equal('context')
  })

  it('finds nothing for a model command or an empty name', function () {
    expect(findLocalSlashCommand('fix')).to.equal(undefined)
    expect(findLocalSlashCommand('')).to.equal(undefined)
  })

  it('matches by id or alias prefix while the name is typed', function () {
    expect(filterLocalSlashCommands('con').map(c => c.id)).to.deep.equal([
      'context',
    ])
    expect(filterLocalSlashCommands('tok').map(c => c.id)).to.deep.equal([
      'context',
    ])
    expect(filterLocalSlashCommands('zzz')).to.deep.equal([])
    expect(filterLocalSlashCommands('comp').map(c => c.id)).to.deep.equal([
      'compact',
    ])
  })

  it('has /compact, which takes instructions', function () {
    expect(findLocalSlashCommand('compact')?.argumentHint).to.equal(
      '[instructions]'
    )
  })

  it('parses a typed local command and the words after it', function () {
    expect(parseLocalSlashInput('/compact')).to.deep.include({ args: '' })
    expect(parseLocalSlashInput('/compact')?.command.id).to.equal('compact')
    const parsed = parseLocalSlashInput(
      '  /compact   keep every label\nand the cite keys  '
    )
    expect(parsed?.command.id).to.equal('compact')
    expect(parsed?.args).to.equal('keep every label\nand the cite keys')
    expect(parseLocalSlashInput('/USAGE')?.command.id).to.equal('context')
    expect(parseLocalSlashInput('/fix the table')).to.equal(null)
    expect(parseLocalSlashInput('please /compact')).to.equal(null)
  })

  it('is never a model command: no catalog entry, and the parser ignores it', function () {
    expect(SLASH_COMMANDS.some(c => c.id === ('context' as string))).to.equal(
      false
    )
    expect(parseSlashInput('/context')).to.equal(null)
  })
})
