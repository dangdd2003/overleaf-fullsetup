import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'chai'
import enTranslations from '../../../../../../locales/en.json'
import extractedTranslations from '../../../../../../frontend/extracted-translations.json'

const MOD_DIR = path.resolve(__dirname, '../../../../')
const FRONTEND_DIR = path.join(MOD_DIR, 'frontend')
const VIEWS_DIR = path.join(MOD_DIR, 'app/views')

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

describe('template gallery i18n keys verification (WP6)', function () {
  it('ensures every static t() translation key used in frontend and views exists in en.json', function () {
    const files = [
      ...walkFiles(FRONTEND_DIR, /\.(tsx?|mjs)$/),
      ...walkFiles(VIEWS_DIR, /\.pug$/),
    ]

    expect(files.length).to.be.greaterThan(0)

    const missingKeys: Array<{ key: string; file: string }> = []
    const keyRegex = /\b(?:t|translate)\(\s*(['"`])([^'"`$]+)\1/g

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8')
      let match: RegExpExecArray | null
      while ((match = keyRegex.exec(content)) !== null) {
        const key = match[2]
        if (!(key in enTranslations)) {
          missingKeys.push({
            key,
            file: path.relative(MOD_DIR, filePath),
          })
        }
      }
    }

    expect(
      missingKeys,
      `Found missing translation keys in en.json: ${JSON.stringify(missingKeys, null, 2)}`
    ).to.deep.equal([])
  })

  // The client only receives keys listed in extracted-translations.json, so a
  // key missing there renders as the raw key on the page
  it('ensures every static t() key used in the frontend is sent to the client', function () {
    const files = walkFiles(FRONTEND_DIR, /\.tsx?$/)
    const missingKeys: Array<{ key: string; file: string }> = []
    const keyRegex =
      /\bt\(\s*(['"`])([^'"`$]+)\1|['"](template_gallery_admin_[a-z0-9_]+)['"]/g

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8')
      let match: RegExpExecArray | null
      while ((match = keyRegex.exec(content)) !== null) {
        const key = match[2] ?? match[3]
        if (!(key in extractedTranslations)) {
          missingKeys.push({ key, file: path.relative(MOD_DIR, filePath) })
        }
      }
    }

    expect(
      missingKeys,
      `Found keys missing from extracted-translations.json: ${JSON.stringify(missingKeys, null, 2)}`
    ).to.deep.equal([])
  })
})
