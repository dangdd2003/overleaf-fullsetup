import Settings from '@overleaf/settings'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULTS,
  parseFetchRpm,
} from '../../../app/src/TemplateGalleryDefaults.mjs'
import { applyModuleSettings } from '../../../app/src/ModuleSettings.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import * as EgressSettings from '../../../app/src/egress/EgressSettings.mjs'
import { createFakeCollection } from './S-P4-support.mjs'
import {
  withHostSlot,
  getHostStatus,
  fetchRpm,
  resetRateGateForTests,
} from '../../../app/src/transport/RateGate.mjs'

describe('overleaf.com request budget', () => {
  let saved

  beforeEach(async () => {
    saved = Settings.templateGalleryFetchRpm
    resetRateGateForTests()
    // Direct lane only
    setCollectionOverrideForTests({
      templateGalleryConfig: createFakeCollection([]),
    })
    EgressSettings.resetEgressSettingsForTests()
    await EgressSettings.refresh()
  })

  afterEach(() => {
    Settings.templateGalleryFetchRpm = saved
    resetRateGateForTests()
    setCollectionOverrideForTests(null)
    EgressSettings.resetEgressSettingsForTests()
  })

  it('defaults to 30 requests a minute', () => {
    expect(DEFAULTS.outbound.fetchRpm).toBe(30)
  })

  it('accepts whole numbers from 1 to 120 only', () => {
    expect(parseFetchRpm('1')).toBe(1)
    expect(parseFetchRpm('120')).toBe(120)
    expect(parseFetchRpm(' 45 ')).toBe(45)
    for (const bad of [undefined, null, '', '0', '121', '-5', '2.5', 'fast']) {
      expect(parseFetchRpm(bad)).toBeNull()
    }
  })

  it('reads TEMPLATE_GALLERY_FETCH_RPM and falls back to the default', () => {
    Settings.templateGalleryFetchRpm = undefined
    applyModuleSettings({ TEMPLATE_GALLERY_FETCH_RPM: '12' })
    expect(Settings.templateGalleryFetchRpm).toBe(12)

    Settings.templateGalleryFetchRpm = undefined
    applyModuleSettings({ TEMPLATE_GALLERY_FETCH_RPM: 'lots' })
    expect(Settings.templateGalleryFetchRpm).toBe(30)

    Settings.templateGalleryFetchRpm = undefined
    applyModuleSettings({})
    expect(Settings.templateGalleryFetchRpm).toBe(30)
  })

  it('reports the overleaf.com budget per route', async () => {
    Settings.templateGalleryFetchRpm = 20
    expect(fetchRpm()).toBe(20)
    await withHostSlot('overleaf', {}, async () => ({ status: 200 }))
    const status = getHostStatus().overleaf
    expect(status.maxPerMinute).toBe(20)
    expect(status.routes).toHaveLength(1)
  })

  it('leaves other hosts unpaced', () => {
    expect(getHostStatus().s3.maxPerMinute).toBeNull()
  })
})
