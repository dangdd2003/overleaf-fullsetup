import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'chai'

const MOD_DIR = path.resolve(__dirname, '../../../../')
const ADMIN_FRONTEND_DIR = path.join(MOD_DIR, 'frontend/js/components/admin')
const ITEM_FRONTEND_DIR = path.join(MOD_DIR, 'frontend/js/components/item')
const PAGES_DIR = path.join(MOD_DIR, 'frontend/js/pages')
const VIEWS_DIR = path.join(MOD_DIR, 'app/views')
const SCSS_DIR = path.join(MOD_DIR, 'frontend/stylesheets')

function walkFiles(dir: string, extensions: RegExp): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, extensions))
    } else if (extensions.test(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

const BANNED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'BS4 badge contextual classes',
    pattern: /\bbadge-(?:info|success|warning|danger|secondary|primary)\b/,
  },
  {
    name: 'BS4 hardcoded background colors',
    pattern: /\b(?:bg-white|bg-light)\b/,
  },
  {
    name: 'BS4 float classes',
    pattern: /\bfloat-(?:left|right)\b/,
  },
  {
    name: 'BS4 typography classes',
    pattern: /\bfont-weight-bold\b/,
  },
  {
    name: 'BS4 spacing classes (ml-*)',
    pattern: /\bml-\d\b/,
  },
  {
    name: 'BS4 legacy modal close class',
    pattern: /\bclose\b(?=.*(?:modal|alert|dismiss))/,
  },
  {
    name: 'Legacy isWebsiteRedesign flag',
    pattern: /\bisWebsiteRedesign\b/,
  },
]

describe('no legacy classes or BS4 markup in admin redesign (WP6)', function () {
  it('scans all redesigned admin and item components for prohibited Bootstrap 4 classes', function () {
    const files = [
      ...walkFiles(ADMIN_FRONTEND_DIR, /\.(tsx?|mjs)$/),
      ...walkFiles(ITEM_FRONTEND_DIR, /\.(tsx?|mjs)$/),
      ...walkFiles(PAGES_DIR, /admin|item/),
      ...walkFiles(VIEWS_DIR, /admin|item/),
      ...walkFiles(SCSS_DIR, /\.scss$/),
    ]

    expect(files.length).to.be.greaterThan(0)

    const violations: Array<{ file: string; rule: string; match: string }> = []

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8')
      for (const { name, pattern } of BANNED_PATTERNS) {
        const match = pattern.exec(content)
        if (match) {
          violations.push({
            file: path.relative(MOD_DIR, filePath),
            rule: name,
            match: match[0],
          })
        }
      }
    }

    expect(
      violations,
      `Found legacy classes in template-gallery admin sources: ${JSON.stringify(violations, null, 2)}`
    ).to.deep.equal([])
  })
})
