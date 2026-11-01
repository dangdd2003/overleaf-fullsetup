import fs from 'node:fs'
import Path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { mergePlain } from './support/mergePlain.mjs'
import { applyModuleSettings } from '../../../app/src/ModuleSettings.mjs'

describe('TemplateGallery ModuleSettings & ModuleGating', () => {
  beforeEach(() => {
    delete Settings.enableTemplateGallery
    delete Settings.templateGallery
  })

  it('defaults enableTemplateGallery to false when TEMPLATE_GALLERY_ENABLED is unset', () => {
    applyModuleSettings({})
    expect(Settings.enableTemplateGallery).toBe(false)
    expect(Settings.templateGallery).toBeUndefined()
  })

  it('registers zero routes when disabled and all expected routes when enabled', async () => {
    vi.doMock(
      '../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: {
          requireLogin: () => (req, res, next) => next(),
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
      () => ({
        default: {
          ensureUserIsSiteAdmin: (req, res, next) => next(),
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: {
          getLoggedInUserId: () => 'user-1',
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
      () => ({
        default: {
          promises: {
            isUserSiteAdmin: async () => true,
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Uploads/ProjectUploadManager.mjs',
      () => ({
        default: {
          promises: {
            createProjectFromZipArchiveWithName: async () => ({
              project: { _id: 'p1' },
            }),
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectRootDocManager.mjs',
      () => ({
        default: {
          promises: {
            setRootDocFromName: async () => true,
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectDeleter.mjs',
      () => ({
        default: {
          promises: {
            deleteProject: async () => {},
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs',
      () => ({
        default: {
          fixProjectName: s => s,
        },
      })
    )
    vi.doMock(
      '../../../../../../app/src/Features/Compile/CompileManager.mjs',
      () => ({
        default: {
          promises: {
            compile: async () => ({ status: 'success' }),
          },
        },
      })
    )
    vi.doMock(
      '../../../../../../app/src/Features/Compile/ClsiManager.mjs',
      () => ({
        default: {
          promises: {
            getOutputFileStream: async () => null,
          },
        },
      })
    )

    const { default: TemplateGalleryModule } =
      await import('../../../index.mjs')

    const routes = []
    const fakeRouter = {
      get: (p, ...h) => routes.push({ method: 'GET', path: p, handlers: h }),
      post: (p, ...h) => routes.push({ method: 'POST', path: p, handlers: h }),
      patch: (p, ...h) =>
        routes.push({ method: 'PATCH', path: p, handlers: h }),
      delete: (p, ...h) =>
        routes.push({ method: 'DELETE', path: p, handlers: h }),
      use: (p, ...h) => routes.push({ method: 'USE', path: p, handlers: h }),
    }

    Settings.enableTemplateGallery = false
    TemplateGalleryModule.router.apply(fakeRouter)
    expect(routes).toHaveLength(0)

    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, {})
    TemplateGalleryModule.router.apply(fakeRouter)
    expect(routes.length).toBeGreaterThanOrEqual(20)
    expect(
      routes.some(r => r.method === 'GET' && r.path === '/templates')
    ).toBe(true)
    expect(
      routes.some(r => r.method === 'GET' && r.path === '/templates/t/:slug')
    ).toBe(true)
    expect(
      routes.some(
        r => r.method === 'POST' && r.path === '/templates/t/:slug/open'
      )
    ).toBe(true)
    expect(
      routes.some(
        r =>
          r.method === 'POST' && r.path === '/admin/templates/api/crawler/sync'
      )
    ).toBe(true)
    expect(
      routes.some(
        r =>
          r.method === 'POST' &&
          r.path === '/admin/templates/api/credentials/session'
      )
    ).toBe(true)
    expect(routes.every(r => !r.path.startsWith('/project/new/template'))).toBe(
      true
    )
  })

  it('contains zero unescaped != interpolations in any Pug view', () => {
    const viewsDir = Path.resolve(import.meta.dirname, '../../../app/views')
    const pugFiles = fs.readdirSync(viewsDir).filter(f => f.endsWith('.pug'))
    expect(pugFiles.length).toBeGreaterThanOrEqual(4)
    for (const file of pugFiles) {
      const content = fs.readFileSync(Path.join(viewsDir, file), 'utf8')
      expect(content).not.toMatch(/!=\s*[a-zA-Z0-9_($.]/m)
    }
  })
})
