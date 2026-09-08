import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('GitHubApiManager', function () {
  let manager
  let fetchStub

  beforeEach(async function () {
    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: { githubSync: { apiBase: 'https://api.github.test' } },
    }))
    manager = (await import('../../../app/src/GitHubApiManager.mjs')).default
    fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
  })

  afterEach(function () {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body, status = 200) {
    return { ok: status < 400, status, json: async () => body }
  }

  it('gets the authenticated user', async function () {
    fetchStub.mockResolvedValueOnce(jsonResponse({ id: 42, login: 'octocat' }))
    const user = await manager.promises.getUser('tok')
    expect(user.login).to.equal('octocat')
    const [url, opts] = fetchStub.mock.calls[0]
    expect(url).to.equal('https://api.github.test/user')
    expect(opts.headers.Authorization).to.equal('Bearer tok')
    expect(opts.headers.Accept).to.equal('application/vnd.github+json')
    expect(opts.headers['User-Agent']).to.equal('overleaf-github-sync')
  })

  it('picks the primary verified email', async function () {
    fetchStub.mockResolvedValueOnce(
      jsonResponse([
        { email: 'a@example.com', primary: false, verified: true },
        { email: 'b@example.com', primary: true, verified: true },
        { email: 'c@example.com', primary: false, verified: false },
      ])
    )
    expect(await manager.promises.getPrimaryEmail('tok')).to.equal('b@example.com')
  })

  it('falls back to first verified, then first email, then null', async function () {
    // first verified when no primary verified
    fetchStub.mockResolvedValueOnce(
      jsonResponse([
        { email: 'unverified-primary@example.com', primary: true, verified: false },
        { email: 'verified-secondary@example.com', primary: false, verified: true },
      ])
    )
    expect(await manager.promises.getPrimaryEmail('tok')).to.equal(
      'verified-secondary@example.com'
    )

    // first email when none verified
    fetchStub.mockResolvedValueOnce(
      jsonResponse([
        { email: 'only-unverified@example.com', primary: false, verified: false },
      ])
    )
    expect(await manager.promises.getPrimaryEmail('tok')).to.equal(
      'only-unverified@example.com'
    )

    // null when list empty
    fetchStub.mockResolvedValueOnce(jsonResponse([]))
    expect(await manager.promises.getPrimaryEmail('tok')).to.equal(null)
  })

  it('maps 401 and 403 to github_credentials_expired', async function () {
    fetchStub.mockResolvedValueOnce(jsonResponse({ message: 'bad' }, 401))
    try {
      await manager.promises.getUser('tok')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.equal('GitHub authorization failed')
      expect(err.code).to.equal('github_credentials_expired')
      expect(err.status).to.equal(401)
    }

    fetchStub.mockResolvedValueOnce(jsonResponse({ message: 'forbidden' }, 403))
    try {
      await manager.promises.getUser('tok')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.equal('GitHub authorization failed')
      expect(err.code).to.equal('github_credentials_expired')
      expect(err.status).to.equal(403)
    }
  })

  it('maps other non-2xx errors to status error', async function () {
    fetchStub.mockResolvedValueOnce(jsonResponse({ message: 'server error' }, 500))
    try {
      await manager.promises.getUser('tok')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.equal('GitHub API responded 500')
      expect(err.status).to.equal(500)
    }
  })

  it('returns null on 204 No Content', async function () {
    fetchStub.mockResolvedValueOnce({ ok: true, status: 204, json: async () => {} })
    const res = await manager.promises.getUser('tok')
    expect(res).to.equal(null)
  })

  it('lists repos across pages up to 5 pages and maps fields', async function () {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `repo-${i}`,
      owner: { login: 'octocat' },
      private: false,
      default_branch: 'main',
      size: i === 0 ? 0 : 100,
    }))
    const page2 = [
      {
        name: 'repo-100',
        owner: { login: 'octocat' },
        private: true,
        default_branch: 'master',
        size: 50,
      },
    ]

    fetchStub
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))

    const repos = await manager.promises.listRepos('tok')
    expect(repos).to.have.lengthOf(101)
    expect(repos[0]).to.deep.equal({
      name: 'repo-0',
      owner: { login: 'octocat' },
      private: false,
      default_branch: 'main',
      empty: true,
    })
    expect(repos[100]).to.deep.equal({
      name: 'repo-100',
      owner: { login: 'octocat' },
      private: true,
      default_branch: 'master',
      empty: false,
    })
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('lists orgs for authenticated user', async function () {
    fetchStub.mockResolvedValueOnce(
      jsonResponse([{ login: 'org-a', id: 1 }, { login: 'org-b', id: 2 }])
    )
    const orgs = await manager.promises.listOrgs('tok')
    expect(orgs).to.deep.equal([{ login: 'org-a' }, { login: 'org-b' }])
    expect(fetchStub.mock.calls[0][0]).to.equal(
      'https://api.github.test/user/orgs?per_page=100'
    )
  })

  it('gets a single repo', async function () {
    fetchStub.mockResolvedValueOnce(
      jsonResponse({ name: 'paper', owner: { login: 'octocat' } })
    )
    const repo = await manager.promises.getRepo('tok', 'octocat', 'paper')
    expect(repo.name).to.equal('paper')
    expect(fetchStub.mock.calls[0][0]).to.equal(
      'https://api.github.test/repos/octocat/paper'
    )
  })

  it('creates a user repo with private flag and gitignore', async function () {
    fetchStub.mockResolvedValueOnce(
      jsonResponse({ name: 'paper', owner: { login: 'octocat' }, default_branch: 'main' })
    )
    const repo = await manager.promises.createRepo('tok', {
      name: 'paper',
      isPrivate: true,
      orgLogin: null,
    })
    expect(repo.name).to.equal('paper')
    const [url, opts] = fetchStub.mock.calls[0]
    expect(url).to.equal('https://api.github.test/user/repos')
    expect(JSON.parse(opts.body)).to.deep.include({
      name: 'paper',
      private: true,
      gitignore_template: 'TeX',
      auto_init: false,
    })
  })

  it('creates an org repo against /orgs/:org/repos', async function () {
    fetchStub.mockResolvedValueOnce(jsonResponse({ name: 'paper' }))
    await manager.promises.createRepo('tok', {
      name: 'paper',
      isPrivate: false,
      orgLogin: 'my-org',
    })
    expect(fetchStub.mock.calls[0][0]).to.equal(
      'https://api.github.test/orgs/my-org/repos'
    )
  })

  it('compares commits and returns ahead/behind counts', async function () {
    fetchStub.mockResolvedValueOnce(
      jsonResponse({ status: 'ahead', ahead_by: 3, behind_by: 0 })
    )
    const cmp = await manager.promises.compareCommits('tok', 'octocat', 'paper', 'abc123', 'main')
    expect(cmp.ahead_by).to.equal(3)
    expect(fetchStub.mock.calls[0][0]).to.equal(
      'https://api.github.test/repos/octocat/paper/compare/abc123...main'
    )
  })
})
