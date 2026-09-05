import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath = '../../../../../app/src/Features/GoogleDriveSync/index.mjs'

describe('GoogleDriveSync index', () => {
  let GoogleDriveSync

  const Features = { hasFeature: vi.fn() }
  const GoogleDrivePollingWorker = { start: vi.fn(), stop: vi.fn() }
  const GoogleDriveOutboundWorker = { start: vi.fn(), stop: vi.fn() }
  const GoogleDriveChannelRenewalWorker = { start: vi.fn(), stop: vi.fn() }
  const GoogleDriveHookHandler = {
    onFileModified: vi.fn(),
    onEntityDeleted: vi.fn(),
    onDocModified: vi.fn(),
  }
  const Modules = { hooks: { attach: vi.fn() } }

  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/Modules.mjs', () => ({
    default: Modules,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs',
    () => ({ default: GoogleDrivePollingWorker })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs',
    () => ({ default: GoogleDriveOutboundWorker })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveChannelRenewalWorker.mjs',
    () => ({ default: GoogleDriveChannelRenewalWorker })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs',
    () => ({ default: GoogleDriveHookHandler })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import(modulePath)
    GoogleDriveSync = mod.default
  })

  it('starts all workers and attaches all three hooks when enabled', () => {
    Features.hasFeature.mockReturnValue(true)

    GoogleDriveSync.start()

    expect(GoogleDrivePollingWorker.start).toHaveBeenCalled()
    expect(GoogleDriveOutboundWorker.start).toHaveBeenCalled()
    expect(GoogleDriveChannelRenewalWorker.start).toHaveBeenCalled()
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'fileModified',
      GoogleDriveHookHandler.onFileModified
    )
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'entityDeleted',
      GoogleDriveHookHandler.onEntityDeleted
    )
    // Without this one, doc content edits never sync at all.
    expect(Modules.hooks.attach).toHaveBeenCalledWith(
      'docModified',
      GoogleDriveHookHandler.onDocModified
    )
  })

  it('does nothing at all when the feature is disabled', () => {
    Features.hasFeature.mockReturnValue(false)

    GoogleDriveSync.start()

    expect(GoogleDrivePollingWorker.start).not.toHaveBeenCalled()
    expect(GoogleDriveOutboundWorker.start).not.toHaveBeenCalled()
    expect(GoogleDriveChannelRenewalWorker.start).not.toHaveBeenCalled()
    expect(Modules.hooks.attach).not.toHaveBeenCalled()
  })
})
