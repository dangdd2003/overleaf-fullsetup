import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_BUILDS_PER_PROJECT,
  MAX_PROJECTS,
  findBuild,
  previousBuild,
  rememberBuild,
  resetBuildRecords,
} from '../../../app/src/McpBuildRecords.mjs'

const FP = { contentHash: 'h', entries: [] }

describe('McpBuildRecords', () => {
  beforeEach(() => resetBuildRecords())

  it('finds a build it recorded, and nothing else', () => {
    rememberBuild('p1', { buildId: 'b1', clsiServerId: 'c1', fingerprint: FP })
    expect(findBuild('p1', 'b1')).toMatchObject({
      buildId: 'b1',
      clsiServerId: 'c1',
      fingerprint: FP,
      fromOverride: false,
    })
    expect(findBuild('p1', 'b2')).toBeNull()
    expect(findBuild('p2', 'b1')).toBeNull()
  })

  it('gives the build compiled before a given one', () => {
    rememberBuild('p1', { buildId: 'b1', clsiServerId: 'c1', fingerprint: FP })
    rememberBuild('p1', { buildId: 'b2', clsiServerId: 'c2', fingerprint: FP })
    expect(previousBuild('p1', 'b2')).toMatchObject({ buildId: 'b1', clsiServerId: 'c1' })
    expect(previousBuild('p1', 'b1')).toBeNull()
    expect(previousBuild('p1', 'unknown')).toBeNull()
  })

  it('moves a re-recorded build to the newest end', () => {
    rememberBuild('p1', { buildId: 'b1', fingerprint: FP })
    rememberBuild('p1', { buildId: 'b2', fingerprint: FP })
    rememberBuild('p1', { buildId: 'b1', fingerprint: { contentHash: 'new' } })
    expect(previousBuild('p1', 'b2')).toBeNull()
    expect(previousBuild('p1', 'b1')).toMatchObject({ buildId: 'b2' })
    expect(findBuild('p1', 'b1').fingerprint.contentHash).toBe('new')
  })

  it('keeps only the newest builds of a project', () => {
    for (let i = 0; i < MAX_BUILDS_PER_PROJECT + 3; i++) {
      rememberBuild('p1', { buildId: `b${i}`, fingerprint: FP })
    }
    expect(findBuild('p1', 'b2')).toBeNull()
    expect(findBuild('p1', 'b3')).not.toBeNull()
  })

  it('forgets the least recently used project past the limit', () => {
    rememberBuild('first', { buildId: 'b1', fingerprint: FP })
    for (let i = 0; i < MAX_PROJECTS; i++) {
      rememberBuild(`p${i}`, { buildId: 'b1', fingerprint: FP })
    }
    expect(findBuild('first', 'b1')).toBeNull()
    expect(findBuild(`p${MAX_PROJECTS - 1}`, 'b1')).not.toBeNull()
  })

  it('forgets other projects when large fingerprints exceed the entry budget', () => {
    const bigEntries = Array.from({ length: 30000 }, (_, i) => ({
      path: `f${i}.tex`,
      digest: 'd',
    }))
    const big = { contentHash: 'big', entries: bigEntries }
    rememberBuild('small', { buildId: 'b1', fingerprint: FP })
    rememberBuild('big1', { buildId: 'b1', fingerprint: big })
    rememberBuild('big2', { buildId: 'b1', fingerprint: big })
    rememberBuild('big3', { buildId: 'b1', fingerprint: big })
    rememberBuild('big4', { buildId: 'b1', fingerprint: big })
    expect(findBuild('small', 'b1')).toBeNull()
    expect(findBuild('big1', 'b1')).toBeNull()
    expect(findBuild('big4', 'b1')).not.toBeNull()
  })

  it('records fromOverride only when asked', () => {
    rememberBuild('p1', { buildId: 'b1', fingerprint: FP, fromOverride: true })
    expect(findBuild('p1', 'b1').fromOverride).toBe(true)
  })
})
