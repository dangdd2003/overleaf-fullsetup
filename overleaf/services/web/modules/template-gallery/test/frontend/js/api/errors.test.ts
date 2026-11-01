import { expect } from 'chai'
import i18next from 'i18next'
import enTranslations from '../../../../../../locales/en.json'
import {
  errorMessage,
  parseErrorBody,
  TemplateAdminApiError,
} from '../../../../frontend/js/api/errors'

// Same interpolation syntax as frontend/js/i18n.ts, with the real en.json,
// so the assertions check the translated strings a user would see
const i18n = i18next.createInstance()

describe('template-gallery admin API errors', function () {
  before(async function () {
    await i18n.init({
      lng: 'en',
      resources: { en: { translation: enTranslations } },
      interpolation: { prefix: '__', suffix: '__', escapeValue: false },
    })
  })

  describe('parseErrorBody', function () {
    it('reads the flat envelope', function () {
      const error = parseErrorBody(409, {
        error: 'revision_conflict',
        message: 'Revision mismatch',
        details: { currentRevision: 7 },
      })

      expect(error).to.be.instanceOf(TemplateAdminApiError)
      expect(error.status).to.equal(409)
      expect(error.code).to.equal('revision_conflict')
      expect(error.message).to.equal('Revision mismatch')
      expect(error.details).to.deep.equal({ currentRevision: 7 })
    })

    it('falls back to a safe code when the body is not an envelope', function () {
      expect(parseErrorBody(502, '<html>bad gateway</html>').code).to.equal(
        'internal_error'
      )
      expect(parseErrorBody(400, null).code).to.equal('generic')
      expect(parseErrorBody(400, null).details).to.deep.equal({})
    })
  })

  describe('TemplateAdminApiError', function () {
    it('is an Error that carries the code and defaults the message to it', function () {
      const error = new TemplateAdminApiError(404, 'not_found', {})

      expect(error).to.be.instanceOf(Error)
      expect(error.name).to.equal('TemplateAdminApiError')
      expect(error.message).to.equal('not_found')
    })
  })

  describe('errorMessage', function () {
    it('translates a known code', function () {
      const error = parseErrorBody(409, { error: 'source_in_progress' })

      expect(errorMessage(i18n.t, error)).to.equal(
        "This template's source is already being fetched. Try again shortly."
      )
    })

    it('uses the generic message for an unknown code and never shows the server text', function () {
      const error = parseErrorBody(400, {
        error: 'brand_new_code',
        message: 'raw server detail',
      })

      const message = errorMessage(i18n.t, error)

      expect(message).to.equal('The request failed.')
      expect(message).not.to.include('raw server detail')
    })

    it('maps any 401 to the session expired message', function () {
      expect(
        errorMessage(i18n.t, parseErrorBody(401, { error: 'unauthorized' }))
      ).to.equal('Your session expired. Sign in again.')
      expect(errorMessage(i18n.t, parseErrorBody(401, null))).to.equal(
        'Your session expired. Sign in again.'
      )
    })

    it('uses the generic message for errors that are not API errors', function () {
      expect(errorMessage(i18n.t, new TypeError('Failed to fetch'))).to.equal(
        'The request failed.'
      )
      expect(errorMessage(i18n.t, undefined)).to.equal('The request failed.')
    })
  })
})
