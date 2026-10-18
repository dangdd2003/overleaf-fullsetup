import { expect } from 'chai'
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  parseSlashInput,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'
import {
  recordSlashCommandUsage,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/usage-store'

describe('slash command catalog', function () {
  describe('parseSlashInput', function () {
    it('reads a bare command name with no args', function () {
      const parsed = parseSlashInput('/fix')
      expect(parsed?.command.id).to.equal('fix')
      expect(parsed?.args).to.equal('')
    })

    it('matches the name case-insensitively and keeps the args', function () {
      const parsed = parseSlashInput('/FIX x')
      expect(parsed?.command.id).to.equal('fix')
      expect(parsed?.args).to.equal('x')
    })

    it('accepts an alias as the command', function () {
      expect(parseSlashInput('/grammar')?.command.id).to.equal('proofread')
      expect(parseSlashInput('/tldr')?.command.id).to.equal('summarize')
      expect(parseSlashInput('/tikz')?.command.id).to.equal('figure')
    })

    it('reads /shorten as /rewrite concise', function () {
      const parsed = parseSlashInput('/shorten 30%')
      expect(parsed?.command.id).to.equal('rewrite')
      expect(parsed?.args).to.equal('concise 30%')
      expect(parseSlashInput('/shorten')?.args).to.equal('concise')
    })

    it('trims the args and any leading space before the name', function () {
      const parsed = parseSlashInput('   /rewrite   make it shorter  ')
      expect(parsed?.command.id).to.equal('rewrite')
      expect(parsed?.args).to.equal('make it shorter')
    })

    it('keeps the line breaks inside args', function () {
      expect(parseSlashInput('/table\nrows and\ncolumns')?.args).to.equal(
        'rows and\ncolumns'
      )
    })

    it('does not read a path at the start of a message as a command', function () {
      expect(parseSlashInput('/usr/bin')).to.equal(null)
      expect(parseSlashInput('/usr/share/fonts are missing')).to.equal(null)
    })

    it('does not read an unknown word as a command', function () {
      expect(parseSlashInput('/unknown')).to.equal(null)
      expect(parseSlashInput('/unknown do this')).to.equal(null)
    })

    it('needs the slash at the very start', function () {
      expect(parseSlashInput('please /fix this')).to.equal(null)
      expect(parseSlashInput('fix this')).to.equal(null)
    })
  })

  describe('findSlashCommand', function () {
    it('finds a command by id or alias, in any case', function () {
      expect(findSlashCommand('TLDR')?.id).to.equal('summarize')
      expect(findSlashCommand('math')?.id).to.equal('equation')
      expect(findSlashCommand('nope')).to.equal(undefined)
    })
  })

  describe('filterSlashCommands', function () {
    it('lists every command in catalog order for an empty query', function () {
      expect(filterSlashCommands('').map(c => c.id)).to.deep.equal(
        SLASH_COMMANDS.map(c => c.id)
      )
    })

    it('puts an id prefix first', function () {
      expect(filterSlashCommands('fix')[0].id).to.equal('fix')
    })

    it('matches an alias prefix', function () {
      expect(filterSlashCommands('grammar')[0].id).to.equal('proofread')
    })

    it('matches a label substring when nothing starts with the query', function () {
      expect(filterSlashCommands('check')[0].id).to.equal('check')
      expect(filterSlashCommands('consistency').map(c => c.id)).to.include('check')
    })

    it('returns nothing for a query that matches nothing', function () {
      expect(filterSlashCommands('zzzz')).to.deep.equal([])
    })

    it('boosts frequently used commands to the top when query is empty', function () {
      try {
        recordSlashCommandUsage('table')
        recordSlashCommandUsage('table')
        recordSlashCommandUsage('table')
        const top = filterSlashCommands('')
        expect(top[0].id).to.equal('table')
      } finally {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.clear()
        }
      }
    })

    it('boosts mostly used commands during search filtering', function () {
      try {
        recordSlashCommandUsage('summarize')
        recordSlashCommandUsage('summarize')
        recordSlashCommandUsage('summarize')
        const results = filterSlashCommands('s')
        expect(results[0].id).to.equal('summarize')
      } finally {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.clear()
        }
      }
    })
  })
})
