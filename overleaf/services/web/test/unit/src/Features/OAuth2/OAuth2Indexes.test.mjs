import { describe, it } from 'vitest'
import { expect } from 'chai'
import { OauthApplicationSchema } from '../../../../../app/src/models/OauthApplication.mjs'
import { OauthAccessTokenSchema } from '../../../../../app/src/models/OauthAccessToken.mjs'

// Dynamic Client Registration made these collections hot: every /oauth/authorize
// looks a client up by `id`, and every refresh looks a token up by
// `refreshToken`. Without indexes both are collection scans, and the client
// collection has no upper bound because anyone may register.
function indexKeys(schema) {
  return schema.indexes().map(([keys]) => keys)
}

function indexOptions(schema, field) {
  const found = schema.indexes().find(([keys]) => keys[field] !== undefined)
  return found ? found[1] : undefined
}

describe('OAuth2 collection indexes', () => {
  it('indexes oauthApplications by the client id used at authorize time', () => {
    expect(indexKeys(OauthApplicationSchema)).to.deep.include({ id: 1 })
  })

  it('makes the oauthApplications client id unique', () => {
    expect(indexOptions(OauthApplicationSchema, 'id')).to.include({
      unique: true,
    })
  })

  it('indexes oauthAccessTokens by refreshToken used at refresh time', () => {
    expect(indexKeys(OauthAccessTokenSchema)).to.deep.include({
      refreshToken: 1,
    })
  })
})
