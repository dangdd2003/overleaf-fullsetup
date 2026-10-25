import { vi, expect, describe, beforeEach, it } from 'vitest'
import Path from 'node:path'

const modulePath = Path.join(
  import.meta.dirname,
  '../../../app/js/AutoPullManager'
)

describe('AutoPullManager', () => {
  beforeEach(ctx => {
    ctx.Settings = { clsi: { docker: {} } }
    vi.doMock('@overleaf/settings', () => ({ default: ctx.Settings }))
    vi.doMock('dockerode', () => ({
      default: class Docker {
        constructor(opts) {
          ctx.dockerOpts = opts
        }

        getImage() {
          return { inspect: async () => ({}) }
        }
      },
    }))
  })

  describe('resolveImageName', () => {
    it('should keep the name without an override', async ctx => {
      const { resolveImageName } = await import(modulePath)
      expect(resolveImageName('quay.io/sharelatex/texlive-full:2026')).to.equal(
        'quay.io/sharelatex/texlive-full:2026'
      )
    })

    it('should apply the registry override and keep the tag', async ctx => {
      ctx.Settings.texliveImageNameOveride = 'mirror.example.com/ol'
      const { resolveImageName } = await import(modulePath)
      expect(resolveImageName('quay.io/sharelatex/texlive-full:2026')).to.equal(
        'mirror.example.com/ol/texlive-full:2026'
      )
    })
  })

  it('should use clsi.docker.clientConfig for the docker client', async ctx => {
    ctx.Settings.clsi.docker.clientConfig = { host: '10.0.0.5', port: 2375 }
    const { imageExists } = await import(modulePath)
    expect(await imageExists('x:1')).to.equal(true)
    expect(ctx.dockerOpts).to.deep.equal({ host: '10.0.0.5', port: 2375 })
  })
})
