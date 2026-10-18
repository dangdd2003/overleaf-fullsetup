import { describe, it, expect } from 'vitest'
import { validateRepoRef } from '../../../app/src/GitHubSyncManager.mjs'

describe('validateRepoRef', function () {
  it('accepts ordinary GitHub owners, repository names and branches', function () {
    expect(() =>
      validateRepoRef({ owner: 'some-org', name: 'my.paper_v2', branch: 'feature/intro' })
    ).not.toThrow()
  })

  it('refuses values that would change the clone URL or the git arguments', function () {
    for (const owner of ['a/b', 'x?y', 'x#y', '-leading', 'evil@host']) {
      expect(() => validateRepoRef({ owner })).toThrow()
    }
    for (const name of ['..', '.', 'a/../b', 'x y', '']) {
      expect(() => validateRepoRef({ name })).toThrow()
    }
    for (const branch of ['-upload-pack=x', 'a..b', 'main.lock', 'a//b', 'x/', 'a b']) {
      expect(() => validateRepoRef({ branch })).toThrow()
    }
  })

  it('marks refused values as bad requests', function () {
    try {
      validateRepoRef({ owner: 'a/b' })
    } catch (err) {
      expect(err.status).toBe(400)
      expect(err.code).toBe('invalidParameters')
    }
  })
})
