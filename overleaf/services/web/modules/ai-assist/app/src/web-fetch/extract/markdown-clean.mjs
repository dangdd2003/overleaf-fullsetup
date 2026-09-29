import { stripTrackingParams } from '../urls.mjs'
import { collapse } from '../util.mjs'

/**
 * Clean-up applied to every Markdown document, whatever produced it (the
 * HTML converter, a provider's page reader, a site adapter): invisible
 * characters, tracking parameters, repeated blocks and link-only blocks go,
 * and heading levels are made consistent. The inside of a code fence is never
 * changed, and running it twice changes nothing.
 */

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const INVISIBLE = /[​-‍⁠﻿­]/g
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
/** Shorter repeated blocks ("Share", "Reply") are left alone. */
const MIN_DUPLICATE_CHARS = 40
/** A block with this many links, mostly link text, is navigation. */
const MIN_NAV_LINKS = 5
const NAV_LINK_SHARE = 0.8

/** The fence marker a line opens ("```", "~~~~"), or null. */
export function fenceMarker(line) {
  return FENCE_LINE.exec(line)?.[1] ?? null
}

/** Whether `line` closes the fence opened by `marker`. */
export function closesFence(marker, line) {
  const match = FENCE_LINE.exec(line)
  return Boolean(
    match &&
    match[1][0] === marker[0] &&
    match[1].length >= marker.length &&
    !match[2].trim()
  )
}

/**
 * The text as blocks separated by blank lines. A fenced code block is one
 * block even when it contains blank lines; a block of lines that all start
 * with "|" is a table.
 */
export function splitBlocks(text) {
  const blocks = []
  let lines = []
  let fence = null
  const flush = () => {
    if (lines.length === 0) return
    blocks.push({
      text: lines.join('\n'),
      kind: lines.every(line => line.startsWith('|')) ? 'table' : 'text',
    })
    lines = []
  }
  for (const line of String(text).split('\n')) {
    if (fence) {
      lines.push(line)
      if (closesFence(fence, line)) {
        blocks.push({ text: lines.join('\n'), kind: 'fence' })
        lines = []
        fence = null
      }
      continue
    }
    const marker = fenceMarker(line)
    if (marker) {
      flush()
      lines.push(line)
      fence = marker
      continue
    }
    if (line.trim()) lines.push(line)
    else flush()
  }
  // A fence left open at the end is still code
  if (fence) blocks.push({ text: lines.join('\n'), kind: 'fence' })
  else flush()
  return blocks
}

function withoutTracking(block) {
  return block.replace(MARKDOWN_LINK, (whole, label, url) => {
    const clean = stripTrackingParams(url)
    return clean === url ? whole : `[${label}](${clean})`
  })
}

function isLinkHeavy(block) {
  const links = [...block.matchAll(MARKDOWN_LINK)]
  if (links.length < MIN_NAV_LINKS) return false
  const linkText = links.reduce(
    (sum, [, label]) => sum + collapse(label).length,
    0
  )
  const visible = collapse(
    block
      .replace(MARKDOWN_LINK, '$1')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/[*_`#>|]/g, '')
  ).length
  return visible > 0 && linkText / visible >= NAV_LINK_SHARE
}

/** Headings shifted so the highest level is ##, with links reduced to text. */
function normalizeHeadings(text) {
  const lines = text.split('\n')
  let min = 7
  let fence = null
  for (const line of lines) {
    if (fence) {
      if (closesFence(fence, line)) fence = null
      continue
    }
    const marker = fenceMarker(line)
    if (marker) {
      fence = marker
      continue
    }
    const heading = /^(#{1,6}) \S/.exec(line)
    if (heading) min = Math.min(min, heading[1].length)
  }
  if (min === 7) return text
  const shift = 2 - min
  fence = null
  return lines
    .map(line => {
      if (fence) {
        if (closesFence(fence, line)) fence = null
        return line
      }
      const marker = fenceMarker(line)
      if (marker) {
        fence = marker
        return line
      }
      const heading = /^(#{1,6}) (\S.*)$/.exec(line)
      if (!heading) return line
      const level = Math.min(6, Math.max(2, heading[1].length + shift))
      return `${'#'.repeat(level)} ${heading[2].replace(MARKDOWN_LINK, '$1')}`
    })
    .join('\n')
}

export function cleanMarkdown(text, baseUrl) {
  const seen = new Set()
  const kept = []
  for (const block of splitBlocks(String(text ?? ''))) {
    if (block.kind === 'fence') {
      kept.push(block.text)
      continue
    }
    let body = block.text.replace(INVISIBLE, '').normalize('NFC')
    if (baseUrl) {
      body = body.replace(
        /\[([^\]]*)\]\(([^)\s]+)\)/g,
        (whole, label, href) => {
          try {
            const resolved = new URL(href, baseUrl)
            if (
              resolved.protocol === 'http:' ||
              resolved.protocol === 'https:'
            ) {
              return `[${label}](${resolved.toString()})`
            }
          } catch {}
          return whole
        }
      )
    }
    body = withoutTracking(body)
    if (block.kind === 'text') {
      if (isLinkHeavy(body)) continue
      const key = collapse(body)
      if (!key) continue
      if (key.length >= MIN_DUPLICATE_CHARS) {
        if (seen.has(key)) continue
        seen.add(key)
      }
    }
    kept.push(body)
  }
  return normalizeHeadings(kept.join('\n\n'))
}
