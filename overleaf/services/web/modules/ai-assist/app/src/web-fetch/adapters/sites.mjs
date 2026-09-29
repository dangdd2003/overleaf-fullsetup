import { makeDocument } from '../document.mjs'
import { fragmentToMarkdown } from '../extract/html.mjs'
import { BROWSER_HEADERS, USER_AGENT } from '../transport.mjs'
import { collapse, isoDay, webError } from '../util.mjs'
import { facts, optional, unescapeXml, unixDay } from './common.mjs'

/**
 * Sites that answer automated readers better through an API or a plainer
 * view than through the page itself. Every one needs no key; when an API
 * limit is hit, the adapter fails and the page is read the normal way.
 */

// GitHub ------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'
const GITHUB_JSON = { Accept: 'application/vnd.github+json' }
/** github.com/<these>/… are site pages, not repositories. */
const GITHUB_RESERVED = new Set([
  'about',
  'apps',
  'collections',
  'customer-stories',
  'enterprise',
  'explore',
  'features',
  'login',
  'marketplace',
  'notifications',
  'orgs',
  'pricing',
  'readme',
  'search',
  'security',
  'settings',
  'site',
  'sponsors',
  'topics',
])

/** What a GitHub link points at, or null for pages the API does not cover. */
export function githubTarget(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'gist.github.com') {
    const gist = /^\/(?:[^/]+\/)?([0-9a-f]{20,40})\/?$/i.exec(url.pathname)
    return gist ? { kind: 'gist', id: gist[1] } : null
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const [owner, rawRepo, section, ...rest] = url.pathname
    .split('/')
    .filter(Boolean)
  if (!owner || !rawRepo || GITHUB_RESERVED.has(owner.toLowerCase()))
    return null
  const repo = rawRepo.replace(/\.git$/, '')
  if (!section) return { kind: 'repo', owner, repo }
  if (section === 'tree' && rest.length <= 1)
    return { kind: 'repo', owner, repo }
  if ((section === 'blob' || section === 'raw') && rest.length >= 2) {
    return { kind: 'file', owner, repo, path: rest.join('/') }
  }
  if (
    (section === 'issues' || section === 'pull') &&
    /^\d+$/.test(rest[0] ?? '')
  ) {
    return { kind: 'issue', owner, repo, number: rest[0] }
  }
  return null
}

function fromBase64(content) {
  return Buffer.from(
    String(content ?? '').replace(/\s+/g, ''),
    'base64'
  ).toString('utf8')
}

async function githubRepo(url, { owner, repo }, ctx) {
  const base = `${GITHUB_API}/repos/${owner}/${repo}`
  const [info, readme] = await Promise.all([
    ctx.getJson(base, GITHUB_JSON),
    optional(ctx.getJson(`${base}/readme`, GITHUB_JSON)),
  ])
  const name = info.full_name ?? `${owner}/${repo}`
  const description = collapse(info.description ?? '')
  const text = [
    `# ${name}`,
    description,
    facts([
      ['Stars', info.stargazers_count],
      ['Language', info.language],
      ['License', info.license?.spdx_id],
      ['Last push', isoDay(info.pushed_at)],
      ['Default branch', info.default_branch],
    ]),
    readme?.content
      ? `## ${readme.name ?? 'README'}\n\n${fromBase64(readme.content)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return makeDocument({
    url,
    title: description ? `${name}: ${description}` : name,
    text,
    modified: isoDay(info.pushed_at),
  })
}

async function githubFile(url, { owner, repo, path }, ctx) {
  const doc = await ctx.readDocument(
    `https://raw.githubusercontent.com/${owner}/${repo}/${path}`,
    { 'User-Agent': USER_AGENT }
  )
  // path is "<ref>/<file path>"
  const file = decodeURIComponent(path.split('/').slice(1).join('/'))
  return { ...doc, url, title: doc.title || `${owner}/${repo}: ${file}` }
}

async function githubIssue(url, { owner, repo, number }, ctx) {
  const base = `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`
  const [issue, comments] = await Promise.all([
    ctx.getJson(base, GITHUB_JSON),
    optional(ctx.getJson(`${base}/comments?per_page=100`, GITHUB_JSON)),
  ])
  const title = collapse(issue.title)
  const text = [
    `# ${title} (#${issue.number})`,
    facts([
      ['Type', issue.pull_request ? 'Pull request' : 'Issue'],
      ['State', issue.state],
      ['Author', issue.user?.login],
      ['Opened', isoDay(issue.created_at)],
      ['Comments', issue.comments],
    ]),
    issue.body ?? '',
    ...(Array.isArray(comments) ? comments : []).map(
      comment =>
        `---\n\n**${comment.user?.login ?? 'someone'}** · ${isoDay(comment.created_at)}\n\n${comment.body ?? ''}`
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
  return makeDocument({
    url,
    title: `${title} · ${owner}/${repo}#${issue.number}`,
    text,
    published: isoDay(issue.created_at),
    modified: isoDay(issue.updated_at),
  })
}

async function githubGist(url, { id }, ctx) {
  const gist = await ctx.getJson(`${GITHUB_API}/gists/${id}`, GITHUB_JSON)
  const files = Object.values(gist.files ?? {}).slice(0, 10)
  const description = collapse(gist.description ?? '')
  const text = [
    `# ${description || 'Gist'}`,
    ...files.map(
      file =>
        `## ${file.filename}\n\n\`\`\`${String(file.language ?? '').toLowerCase()}\n${file.content ?? ''}\n\`\`\``
    ),
  ].join('\n\n')
  return makeDocument({
    url,
    title: description || files[0]?.filename || 'Gist',
    text,
    modified: isoDay(gist.updated_at),
  })
}

export const githubAdapter = {
  name: 'github',
  match: url => Boolean(githubTarget(url)),
  read(url, ctx) {
    const target = githubTarget(new URL(url))
    if (target.kind === 'file') return githubFile(url, target, ctx)
    if (target.kind === 'issue') return githubIssue(url, target, ctx)
    if (target.kind === 'gist') return githubGist(url, target, ctx)
    return githubRepo(url, target, ctx)
  },
}

// Wikipedia ---------------------------------------------------------------

const WIKIPEDIA_HOST = /^([a-z0-9-]+)\.(?:m\.)?wikipedia\.org$/i

export const wikipediaAdapter = {
  name: 'wikipedia',
  match: url =>
    WIKIPEDIA_HOST.test(url.hostname) && /^\/wiki\/[^/]+$/.test(url.pathname),
  async read(url, ctx) {
    const parsed = new URL(url)
    const lang = WIKIPEDIA_HOST.exec(parsed.hostname)[1].toLowerCase()
    // the title is already percent-encoded in the path
    const title = parsed.pathname.slice('/wiki/'.length)
    const doc = await ctx.readDocument(
      `https://${lang}.wikipedia.org/api/rest_v1/page/html/${title}`,
      { 'User-Agent': USER_AGENT, Accept: 'text/html' }
    )
    return { ...doc, url }
  },
}

// StackExchange -----------------------------------------------------------

const STACKEXCHANGE_SITES =
  /^(?:(?:[a-z0-9-]+\.)*stackexchange\.com|(?:meta\.)?(?:stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net|stackapps\.com))$/i

function questionId(url) {
  return /^\/(?:questions|q)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null
}

function siteOf(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '')
}

export const stackexchangeAdapter = {
  name: 'stackexchange',
  match: url =>
    STACKEXCHANGE_SITES.test(siteOf(url)) && Boolean(questionId(url)),
  async read(url, ctx) {
    const parsed = new URL(url)
    const site = siteOf(parsed)
    const id = questionId(parsed)
    const api = `https://api.stackexchange.com/2.3/questions/${id}`
    const query = `site=${encodeURIComponent(site)}&filter=withbody`
    const [question, answers] = await Promise.all([
      ctx.getJson(`${api}?${query}`),
      ctx.getJson(`${api}/answers?${query}&sort=votes&order=desc&pagesize=30`),
    ])
    const q = question?.items?.[0]
    if (!q)
      throw webError(`${site} has no question ${id}.`, { kind: 'network' })
    const list = Array.isArray(answers?.items) ? answers.items : []
    const ordered = [
      ...list.filter(a => a.is_accepted),
      ...list.filter(a => !a.is_accepted),
    ]
    const base = `https://${site}/`
    const title = unescapeXml(q.title)
    const text = [
      `# ${title}`,
      facts([
        ['Score', q.score],
        ['Asked', unixDay(q.creation_date)],
        ['Answers', q.answer_count],
        ['Tags', (q.tags ?? []).join(', ')],
      ]),
      fragmentToMarkdown(q.body ?? '', base),
      ...ordered.map(answer =>
        [
          `## ${answer.is_accepted ? 'Accepted answer' : 'Answer'}`,
          facts([
            ['Score', answer.score],
            ['By', unescapeXml(answer.owner?.display_name ?? '')],
            ['Answered', unixDay(answer.creation_date)],
          ]),
          fragmentToMarkdown(answer.body ?? '', base),
        ].join('\n\n')
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    return makeDocument({
      url,
      title,
      text,
      published: unixDay(q.creation_date),
      modified: unixDay(q.last_activity_date),
    })
  },
}

// Reddit ------------------------------------------------------------------

const REDDIT_HOSTS = /^(?:www\.|old\.|new\.|np\.)?reddit\.com$/i

function redditThreadPath(url) {
  if (!REDDIT_HOSTS.test(url.hostname)) return null
  return (
    /^(\/r\/[^/]+\/comments\/[a-z0-9]+)(?:\/[^/]*)?\/?$/i.exec(
      url.pathname
    )?.[1] ?? null
  )
}

function redditThread(listing) {
  const post = listing?.[0]?.data?.children?.[0]?.data
  if (!post) return null
  const comments = (listing?.[1]?.data?.children ?? [])
    .filter(child => child?.kind === 't1')
    .map(child => child.data)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 50)
  return { post, comments }
}

export const redditAdapter = {
  name: 'reddit',
  match: url => Boolean(redditThreadPath(url)),
  async read(url, ctx) {
    const path = redditThreadPath(new URL(url))
    const thread = redditThread(
      await optional(
        ctx.getJson(`https://www.reddit.com${path}.json?raw_json=1&limit=100`, {
          'User-Agent': BROWSER_HEADERS['User-Agent'],
        })
      )
    )
    if (!thread) {
      // Reddit refuses its JSON to many server addresses; old.reddit is plain HTML
      const doc = await ctx.readDocument(`https://old.reddit.com${path}/`)
      return { ...doc, url }
    }
    const { post, comments } = thread
    const title = collapse(post.title)
    const text = [
      `# ${title}`,
      facts([
        ['Subreddit', post.subreddit_name_prefixed],
        ['By', post.author],
        ['Score', post.score],
        ['Posted', unixDay(post.created_utc)],
        ['Comments', post.num_comments],
      ]),
      post.selftext || (post.is_self ? '' : `Link: ${post.url}`),
      ...comments.map(
        comment =>
          `---\n\n**${comment.author}** · score ${comment.score} · ${unixDay(comment.created_utc)}\n\n${comment.body ?? ''}`
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    return makeDocument({
      url,
      title,
      text,
      published: unixDay(post.created_utc),
    })
  },
}

// CTAN --------------------------------------------------------------------

const CTAN_MIRROR = 'https://mirrors.ctan.org'

function ctanPackage(url) {
  if (!/^(?:www\.)?ctan\.org$/i.test(url.hostname)) return null
  return /^\/pkg\/([A-Za-z0-9_.-]+)\/?$/.exec(url.pathname)?.[1] ?? null
}

/** CTAN names files `ctan:/path`; they are served from its mirror network. */
function ctanHref(href) {
  const value = String(href ?? '')
  if (value.startsWith('ctan:'))
    return `${CTAN_MIRROR}${value.slice('ctan:'.length)}`
  return /^https?:\/\//i.test(value) ? value : ''
}

export const ctanAdapter = {
  name: 'ctan',
  match: url => Boolean(ctanPackage(url)),
  async read(url, ctx) {
    const name = ctanPackage(new URL(url))
    const pkg = await ctx.getJson(
      `https://ctan.org/json/2.0/pkg/${encodeURIComponent(name)}`
    )
    if (!pkg?.id)
      throw webError(`CTAN has no package ${name}.`, { kind: 'network' })
    const description =
      (pkg.descriptions ?? []).find(d => !d.language || d.language === 'en') ??
      pkg.descriptions?.[0]
    const docs = (pkg.documentation ?? [])
      .map(entry => ({
        label: collapse(entry.details || entry.href),
        href: ctanHref(entry.href),
      }))
      .filter(entry => entry.href)
    const caption = collapse(pkg.caption ?? '')
    const text = [
      `# ${pkg.name}${caption ? ` — ${caption}` : ''}`,
      facts([
        ['Version', pkg.version?.number],
        ['Date', pkg.version?.date],
        [
          'Licence',
          Array.isArray(pkg.license) ? pkg.license.join(', ') : pkg.license,
        ],
      ]),
      description?.text
        ? fragmentToMarkdown(description.text, 'https://ctan.org/')
        : '',
      docs.length
        ? `## Documentation\n\n${docs.map(entry => `- [${entry.label}](${entry.href})`).join('\n')}`
        : '',
      facts([
        ['Home', pkg.home],
        ['Repository', pkg.repository],
        ['Bugs', pkg.bugs],
        ['CTAN path', pkg.ctan?.path ? `${CTAN_MIRROR}${pkg.ctan.path}` : ''],
      ]),
    ]
      .filter(Boolean)
      .join('\n\n')
    return makeDocument({
      url,
      title: `CTAN: ${pkg.name}${caption ? ` – ${caption}` : ''}`,
      text,
      modified: isoDay(pkg.version?.date),
    })
  },
}
