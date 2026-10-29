import fs from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('template gallery production dependencies', () => {
  it('keeps the eagerly imported HTML parser after production focus', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL('../../../../../package.json', import.meta.url),
        'utf8'
      )
    )
    expect(manifest.dependencies.cheerio).toBe('1.0.0-rc.10')
    expect(manifest.devDependencies.cheerio).toBeUndefined()
  })
})
