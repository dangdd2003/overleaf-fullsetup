import Settings from '@overleaf/settings'

const USER_AGENT = 'overleaf-github-sync'

async function _request(token, method, apiPath, body) {
  const url = `${Settings.githubSync.apiBase}${apiPath}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 || res.status === 403) {
    const err = new Error('GitHub authorization failed')
    err.code = 'github_credentials_expired'
    err.status = res.status
    throw err
  }
  if (!res.ok) {
    const err = new Error(`GitHub API responded ${res.status}`)
    err.status = res.status
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

async function getUser(token) {
  return _request(token, 'GET', '/user')
}

async function getPrimaryEmail(token) {
  const emails = await _request(token, 'GET', '/user/emails')
  const verified = emails.filter(e => e.verified)
  const primary = verified.find(e => e.primary)
  return (primary || verified[0] || emails[0] || {}).email || null
}

async function listRepos(token) {
  const repos = []
  for (let page = 1; page <= 5; page++) {
    const batch = await _request(
      token,
      'GET',
      `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`
    )
    repos.push(...batch)
    if (batch.length < 100) break
  }
  return repos.map(r => ({
    name: r.name,
    owner: { login: r.owner.login },
    private: r.private,
    default_branch: r.default_branch,
    empty: r.size === 0,
  }))
}

async function listOrgs(token) {
  const orgs = await _request(token, 'GET', '/user/orgs?per_page=100')
  return orgs.map(o => ({ login: o.login }))
}

async function getRepo(token, owner, name) {
  return _request(
    token,
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  )
}

async function createRepo(token, { name, isPrivate, orgLogin }) {
  const apiPath = orgLogin
    ? `/orgs/${encodeURIComponent(orgLogin)}/repos`
    : '/user/repos'
  return _request(token, 'POST', apiPath, {
    name,
    private: Boolean(isPrivate),
    gitignore_template: 'TeX',
    auto_init: false,
  })
}

async function compareCommits(token, owner, name, baseSha, headRef) {
  return _request(
    token,
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headRef)}`
  )
}

const GitHubApiManager = {
  promises: {
    getUser,
    getPrimaryEmail,
    listRepos,
    listOrgs,
    getRepo,
    createRepo,
    compareCommits,
  },
}

export default GitHubApiManager
