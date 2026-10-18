import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import {
  seal,
  open,
  isStale,
  ConnectorSecretUnavailableError,
} from '../../../../app/src/connectors/ConnectorCrypto.mjs'

const SECRET_A = 'session-secret-a-0123456789abcdef'
const SECRET_B = 'session-secret-b-fedcba9876543210'
const CONTEXT = 'aiAssistConnectorCredentials:507f1f77bcf86cd799439011:headers'
const OTHER_CONTEXT =
  'aiAssistConnectorCredentials:507f1f77bcf86cd799439022:headers'

describe('ConnectorCrypto', function () {
  const originalSecurity = Settings.security

  beforeEach(function () {
    Settings.security = { sessionSecret: SECRET_A }
  })

  afterEach(function () {
    Settings.security = originalSecurity
  })

  it('seals to the v2 format: version, key id, iv, auth tag, ciphertext', function () {
    const sealed = seal({ token: 'abc' }, CONTEXT)
    const parts = sealed.split(':')

    expect(parts).to.have.lengthOf(5)
    expect(parts[0]).to.equal('v2')
    expect(parts[1]).to.match(/^[0-9a-f]{8}$/)
    expect(parts[2]).to.match(/^[0-9a-f]{24}$/) // 12-byte IV
    expect(parts[3]).to.match(/^[0-9a-f]{32}$/) // 16-byte GCM tag
    expect(parts[4]).to.match(/^[0-9a-f]+$/)
  })

  it('round-trips strings, nested JSON and falsy values', function () {
    const values = [
      'Authorization: Bearer secret-token-xyz',
      { access_token: 'at', nested: { a: [1, 2, 3], flag: true } },
      0,
      false,
      '',
    ]
    for (const value of values) {
      expect(open(seal(value, CONTEXT), CONTEXT)).to.deep.equal(value)
    }
  })

  it('uses a fresh IV, so sealing the same value twice differs', function () {
    const first = seal({ same: 'value' }, CONTEXT)
    const second = seal({ same: 'value' }, CONTEXT)

    expect(first).to.not.equal(second)
    expect(open(first, CONTEXT)).to.deep.equal(open(second, CONTEXT))
  })

  it('seals null and undefined to null and opens an empty field to null', function () {
    expect(seal(null, CONTEXT)).to.be.null
    expect(seal(undefined, CONTEXT)).to.be.null
    expect(open(null, CONTEXT)).to.be.null
    expect(open(undefined, CONTEXT)).to.be.null
    expect(open('', CONTEXT)).to.be.null
    expect(open(42, CONTEXT)).to.be.null
  })

  it('refuses a value that is not in the v2 format', function () {
    for (const sealed of ['invalid-payload', 'iv:tag:ct', 'v1:00:11:22:33']) {
      let error = null
      try {
        open(sealed, CONTEXT)
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(ConnectorSecretUnavailableError)
      expect(error.code).to.equal('SECRET_UNAVAILABLE')
    }
  })

  it('fails to open when the ciphertext or auth tag has been tampered with', function () {
    const sealed = seal({ key: 'value' }, CONTEXT)
    const [version, keyId, iv, tag, cipher] = sealed.split(':')
    const flipped = cipher.slice(0, -2) + (cipher.endsWith('aa') ? 'bb' : 'aa')
    const badTag = (tag.startsWith('0') ? '1' : '0') + tag.slice(1)

    expect(() =>
      open([version, keyId, iv, tag, flipped].join(':'), CONTEXT)
    ).to.throw(ConnectorSecretUnavailableError)
    expect(() =>
      open([version, keyId, iv, badTag, cipher].join(':'), CONTEXT)
    ).to.throw(ConnectorSecretUnavailableError)
  })

  it('does not open a ciphertext copied to another connector or field', function () {
    // The context is the GCM additional data: a copied row must not decrypt
    const sealed = seal({ token: 'secret' }, CONTEXT)

    expect(() => open(sealed, OTHER_CONTEXT)).to.throw(
      ConnectorSecretUnavailableError
    )
    expect(() =>
      open(sealed, CONTEXT.replace(/headers$/, 'tokens'))
    ).to.throw(ConnectorSecretUnavailableError)
  })

  it('reports ConnectorSecretUnavailableError when the session secret has changed', function () {
    const sealed = seal({ token: 'secret' }, CONTEXT)
    Settings.security = { sessionSecret: SECRET_B }

    expect(() => open(sealed, CONTEXT)).to.throw(
      ConnectorSecretUnavailableError,
      /session secret changed/
    )
  })

  it('keeps opening what the previous secret sealed while it is the fallback, and marks it stale', function () {
    const sealed = seal({ token: 'rotate-me' }, CONTEXT)
    Settings.security = {
      sessionSecret: SECRET_B,
      sessionSecretFallback: SECRET_A,
    }

    expect(open(sealed, CONTEXT)).to.deep.equal({ token: 'rotate-me' })
    expect(isStale(sealed)).to.be.true
  })

  it('opens what an upcoming secret sealed, during a rollout that has not switched yet', function () {
    Settings.security = { sessionSecret: SECRET_B }
    const sealed = seal({ token: 'upcoming' }, CONTEXT)

    Settings.security = {
      sessionSecret: SECRET_A,
      sessionSecretUpcoming: SECRET_B,
    }
    expect(open(sealed, CONTEXT)).to.deep.equal({ token: 'upcoming' })
    expect(isStale(sealed)).to.be.true
  })

  it('seals with the current secret after rotation, which the old secret alone cannot open', function () {
    Settings.security = {
      sessionSecret: SECRET_B,
      sessionSecretFallback: SECRET_A,
    }
    const resealed = seal({ token: 'new' }, CONTEXT)
    expect(isStale(resealed)).to.be.false

    Settings.security = { sessionSecret: SECRET_A }
    expect(() => open(resealed, CONTEXT)).to.throw(
      ConnectorSecretUnavailableError
    )
  })

  it('treats a value sealed under the current secret as fresh, and empty fields as not stale', function () {
    expect(isStale(seal({ a: 1 }, CONTEXT))).to.be.false
    expect(isStale(null)).to.be.false
    expect(isStale('')).to.be.false
  })

  it('refuses to seal when the instance has no session secret', function () {
    Settings.security = {}

    expect(() => seal({ a: 1 }, CONTEXT)).to.throw(/no session secret/)
  })
})
