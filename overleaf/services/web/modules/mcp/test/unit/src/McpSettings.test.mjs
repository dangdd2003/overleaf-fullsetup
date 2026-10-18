import { describe, it, expect } from 'vitest'
import Settings from '@overleaf/settings'

describe('MCP settings', () => {
  it('enableMcp defaults to false', () => {
    expect(Settings.enableMcp).toBe(false)
  })
})
