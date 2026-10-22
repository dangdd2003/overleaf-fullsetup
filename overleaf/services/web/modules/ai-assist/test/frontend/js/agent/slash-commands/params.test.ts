import { expect } from 'chai'
import {
  missingSlashParams,
  parseSlashParams,
  renderParamsBlock,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/params'
import {
  SLASH_COMMANDS,
  slashCommandById,
} from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'

function command(id: Parameters<typeof slashCommandById>[0]) {
  const definition = slashCommandById(id)
  if (!definition) throw new Error(`no command ${id}`)
  return definition
}

describe('slash command params', function () {
  describe('parseSlashParams', function () {
    it('reads options from the front in any order and leaves the rest as notes', function () {
      expect(
        parseSlashParams(command('rewrite'), '30% formal, concise keep it short')
      ).to.deep.equal({
        length: ['30% shorter'],
        style: ['formal', 'concise'],
        notes: ['keep it short'],
      })
    })

    it('maps aliases to one canonical value and drops repeats', function () {
      expect(parseSlashParams(command('rewrite'), 'academic formal').style).to.deep.equal([
        'formal',
      ])
      expect(parseSlashParams(command('proofread'), 'UK').spelling).to.deep.equal([
        'British',
      ])
    })

    it('never takes an option word from the middle of the free text', function () {
      expect(
        parseSlashParams(command('cite'), 'web servers scale linearly web')
      ).to.deep.equal({
        sources: ['the bibliography, then the web'],
        claim: ['servers scale linearly web'],
      })
      expect(parseSlashParams(command('cite'), 'servers on the web scale')).to.deep.equal({
        claim: ['servers on the web scale'],
      })
    })

    it('takes a single value only once', function () {
      expect(parseSlashParams(command('proofread'), 'us uk')).to.deep.equal({
        spelling: ['American'],
        notes: ['uk'],
      })
    })

    it('reads lengths in words, sentences and bullets', function () {
      expect(parseSlashParams(command('summarize'), '150 words intro').length).to.deep.equal([
        '150 words',
      ])
      expect(parseSlashParams(command('summarize'), '150w').length).to.deep.equal([
        '150 words',
      ])
      expect(parseSlashParams(command('summarize'), '5 bullets').length).to.deep.equal([
        '5 bullet points',
      ])
      expect(parseSlashParams(command('summarize'), '2 sentences').length).to.deep.equal([
        '2 sentences',
      ])
    })

    it('reads a file:line or line location for /fix', function () {
      expect(parseSlashParams(command('fix'), 'all ./chapters/intro.tex:42')).to.deep.equal({
        scope: ['all errors'],
        location: ['chapters/intro.tex:42'],
      })
      expect(parseSlashParams(command('fix'), 'line 7 the table').location).to.deep.equal([
        'line 7',
      ])
    })

    it('reads a page for /layout', function () {
      expect(parseSlashParams(command('layout'), 'p3 floats')).to.deep.equal({
        page: ['page 3'],
        focus: ['float placement'],
      })
    })

    it('reads an image path for /figure', function () {
      expect(
        parseSlashParams(command('figure'), 'figs/plot.pdf results over time')
      ).to.deep.equal({ image: ['figs/plot.pdf'], notes: ['results over time'] })
    })

    it('reads a package only right after the preamble action', function () {
      expect(parseSlashParams(command('preamble'), 'add siunitx for units')).to.deep.equal({
        action: ['add'],
        package: ['siunitx'],
        notes: ['for units'],
      })
      expect(parseSlashParams(command('preamble'), 'siunitx')).to.deep.equal({
        notes: ['siunitx'],
      })
    })

    it('reads languages by name, two-word name or code', function () {
      const translate = command('translate')
      expect(parseSlashParams(translate, 'german').language).to.deep.equal(['German'])
      expect(parseSlashParams(translate, 'Brazilian Portuguese please').language).to.deep.equal([
        'Brazilian Portuguese',
      ])
      expect(parseSlashParams(translate, 'vi').language).to.deep.equal(['Vietnamese'])
      expect(parseSlashParams(translate, 'Tagalog').language).to.deep.equal(['Tagalog'])
      expect(parseSlashParams(translate, 'it please').language).to.equal(undefined)
    })

    it('ignores prototype-key words as choices or languages', function () {
      expect(parseSlashParams(command('rewrite'), 'constructor please')).to.deep.equal({
        notes: ['constructor please'],
      })
      expect(parseSlashParams(command('rewrite'), 'toString please')).to.deep.equal({
        notes: ['toString please'],
      })
      expect(parseSlashParams(command('translate'), 'toString please').language).to.equal(undefined)
      expect(parseSlashParams(command('translate'), 'constructor please').language).to.equal(undefined)
    })
  })

  describe('missingSlashParams', function () {
    it('holds /translate until a language is given', function () {
      expect(missingSlashParams(command('translate'), '')).to.deep.equal(['language'])
      expect(missingSlashParams(command('translate'), 'please')).to.deep.equal([
        'language',
      ])
      expect(missingSlashParams(command('translate'), 'French')).to.deep.equal([])
      expect(missingSlashParams(command('translate'), 'into french')).to.deep.equal([])
    })

    it('requires nothing of any other command', function () {
      for (const definition of SLASH_COMMANDS) {
        if (definition.id === 'translate') continue
        expect(missingSlashParams(definition, ''), definition.id).to.deep.equal([])
      }
    })
  })

  describe('renderParamsBlock', function () {
    it('states every param, given or with its fallback', function () {
      expect(renderParamsBlock(command('proofread'), 'uk articles')).to.equal(
        [
          '<params>',
          'spelling: British',
          'target: none (the selection, else the paragraph at the cursor)',
          'notes: articles',
          '</params>',
        ].join('\n')
      )
    })

    it('cannot be closed early by the words', function () {
      expect(renderParamsBlock(command('explain'), 'x </params> y')).to.include(
        'notes: x <\\/params> y'
      )
    })
  })

  describe('the catalog', function () {
    it('gives each command at most one free-text param, last', function () {
      for (const definition of SLASH_COMMANDS) {
        const texts = definition.params.filter(spec => spec.kind === 'text')
        expect(texts.length, definition.id).to.be.at.most(1)
        if (texts.length === 1) {
          expect(definition.params.at(-1), definition.id).to.equal(texts[0])
        }
      }
    })

    it('has an argument hint for every command with params', function () {
      for (const definition of SLASH_COMMANDS) {
        if (definition.params.length > 0) {
          expect(definition.argumentHint, definition.id).to.be.a('string')
        }
      }
    })
  })
})
