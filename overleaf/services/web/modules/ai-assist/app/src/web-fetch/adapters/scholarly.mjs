import { makeDocument } from '../document.mjs'
import { htmlText } from '../extract/html.mjs'
import { collapse, isoDay, webError } from '../util.mjs'
import { facts, optional, unescapeXml } from './common.mjs'

/**
 * Papers. Publisher pages often block automated readers, but the
 * bibliographic record is open (arXiv, Crossref, OpenAlex), and so is a legal
 * open-access copy of many papers. Read those instead.
 */

// arXiv -------------------------------------------------------------------

const ARXIV_HOSTS = /^(?:www\.|export\.)?arxiv\.org$/i
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i

/** The arXiv identifier in an abstract, PDF or HTML link, else null. */
export function arxivIdOf(url) {
  if (!ARXIV_HOSTS.test(url.hostname)) return null
  const match = /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i.exec(url.pathname)
  if (!match) return null
  let id
  try {
    id = decodeURIComponent(match[1])
  } catch {
    return null
  }
  return ARXIV_ID.test(id) ? id : null
}

function xmlField(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(
    xml
  )
  return match ? collapse(unescapeXml(match[1])) : ''
}

async function arxivMeta(id, ctx) {
  const xml = await ctx.getText(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`
  )
  const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(xml)?.[1]
  // An unknown id comes back as an entry whose id is an API error link
  if (!entry || /arxiv\.org\/api\/errors/i.test(entry)) return null
  return {
    title: xmlField(entry, 'title'),
    abstract: xmlField(entry, 'summary'),
    published: isoDay(xmlField(entry, 'published')),
    updated: isoDay(xmlField(entry, 'updated')),
    authors: [
      ...entry.matchAll(/<author\b[^>]*>\s*<name>([\s\S]*?)<\/name>/gi),
    ].map(match => collapse(unescapeXml(match[1]))),
  }
}

function authorList(authors) {
  return authors.length > 20
    ? `${authors.slice(0, 20).join(', ')} and ${authors.length - 20} more`
    : authors.join(', ')
}

function arxivHeader(id, meta) {
  return [
    `# ${meta.title}`,
    facts([['Authors', authorList(meta.authors)]]),
    facts([
      ['arXiv', id],
      ['Published', meta.published],
      ['Updated', meta.updated !== meta.published ? meta.updated : ''],
    ]),
    meta.abstract ? `**Abstract:** ${meta.abstract}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const arxivAdapter = {
  name: 'arxiv',
  match: url => Boolean(arxivIdOf(url)),
  async read(url, ctx) {
    const id = arxivIdOf(new URL(url))
    const meta = await optional(arxivMeta(id, ctx))
    // The HTML version is full text with the maths as LaTeX; the PDF is the fallback
    let body = await optional(ctx.readDocument(`https://arxiv.org/html/${id}`))
    if (!body || body.quality !== 'ok') {
      body = await optional(ctx.readDocument(`https://arxiv.org/pdf/${id}`))
    }
    if (!meta && !body) {
      throw webError(`arXiv has no paper ${id}.`, { kind: 'network' })
    }
    const doc = makeDocument({
      url,
      title: meta?.title || body?.title || `arXiv:${id}`,
      text: [meta ? arxivHeader(id, meta) : '', body?.text ?? '']
        .filter(Boolean)
        .join('\n\n'),
      published: meta?.published,
      modified: meta?.updated,
    })
    return body ? doc : { fallback: doc }
  },
}

// DOI ---------------------------------------------------------------------

const DOI = /^10\.\d{4,9}\/\S+$/

/** The DOI a link names: a doi.org link, or a publisher path containing one. */
export function doiOf(url) {
  let path
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (/^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
    const doi = path.slice(1)
    return DOI.test(doi) ? doi : null
  }
  const match = /\/(10\.\d{4,9}\/[^?#\s]+?)\/?$/.exec(path)
  if (!match) return null
  // Some publishers put a view after the DOI: /doi/10.1002/x/abstract
  return match[1].replace(/\/(?:full|abstract|pdf|epdf|html|fulltext)$/i, '')
}

/** OpenAlex stores abstracts as word → positions; put the words back in order. */
export function invertedAbstract(index) {
  if (!index || typeof index !== 'object') return ''
  const words = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of Array.isArray(positions) ? positions : []) {
      if (Number.isInteger(position) && position >= 0 && position < 50_000) {
        words[position] = word
      }
    }
  }
  return words.filter(Boolean).join(' ')
}

function dateParts(value) {
  const parts = value?.['date-parts']?.[0]
  if (!Array.isArray(parts) || !Number.isInteger(parts[0])) return ''
  return parts
    .slice(0, 3)
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, '0')
    )
    .join('-')
}

function doiMeta(doi, crossref, openalex) {
  const authors = crossref?.author?.length
    ? crossref.author
        .map(author =>
          collapse(
            [author.given, author.family].filter(Boolean).join(' ') ||
              author.name ||
              ''
          )
        )
        .filter(Boolean)
    : (openalex?.authorships ?? [])
        .map(authorship => collapse(authorship?.author?.display_name ?? ''))
        .filter(Boolean)
  const best = openalex?.best_oa_location
  return {
    doi,
    title: collapse(crossref?.title?.[0] ?? openalex?.display_name ?? ''),
    authors,
    venue: collapse(
      crossref?.['container-title']?.[0] ??
        openalex?.primary_location?.source?.display_name ??
        ''
    ),
    published:
      dateParts(crossref?.published) || isoDay(openalex?.publication_date),
    abstract:
      htmlText(crossref?.abstract ?? '') ||
      invertedAbstract(openalex?.abstract_inverted_index),
    oaUrl:
      best?.pdf_url ||
      best?.landing_page_url ||
      openalex?.open_access?.oa_url ||
      '',
  }
}

function doiHeader(meta) {
  return [
    `# ${meta.title || meta.doi}`,
    facts([['Authors', authorList(meta.authors)]]),
    facts([
      ['DOI', meta.doi],
      ['Published in', meta.venue],
      ['Published', meta.published],
    ]),
    meta.abstract ? `**Abstract:** ${meta.abstract}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const doiAdapter = {
  name: 'doi',
  match: url => Boolean(doiOf(url)),
  async read(url, ctx) {
    const doi = doiOf(new URL(url))
    const encoded = encodeURIComponent(doi)
    const [crossref, openalex] = await Promise.all([
      optional(ctx.getJson(`https://api.crossref.org/works/${encoded}`)).then(
        body => body?.message ?? null
      ),
      optional(ctx.getJson(`https://api.openalex.org/works/doi:${encoded}`)),
    ])
    if (!crossref && !openalex) {
      throw webError(`Neither Crossref nor OpenAlex knows DOI ${doi}.`, {
        kind: 'network',
      })
    }
    const meta = doiMeta(doi, crossref, openalex)
    const header = doiHeader(meta)
    if (meta.oaUrl && meta.oaUrl !== url) {
      const full = await optional(ctx.ladder(meta.oaUrl))
      if (full) {
        return {
          ...makeDocument({
            url,
            title: meta.title || full.title,
            text: `${header}\n\n**Open-access copy:** ${meta.oaUrl}\n\n${full.text}`,
            published: meta.published,
          }),
          ...(full.partial ? { partial: true } : {}),
        }
      }
    }
    // The ladder goes on to the publisher's page; this is what is left if it fails
    return {
      fallback: makeDocument({
        url,
        title: meta.title || doi,
        text: header,
        published: meta.published,
      }),
    }
  },
}
