import { describe, it, expect } from 'vitest'
import Settings from '@overleaf/settings'

describe('MCP settings', () => {
  it('enableMcp defaults to false', () => {
    expect(Settings.enableMcp).toBe(false)
  })
  it('exposes an mcp upload config block', () => {
    expect(Settings.mcp.maxUploadBytes).toBeGreaterThan(0)
    expect(Settings.mcp.allowedUploadExtensions).toContain('png')
  })
})
