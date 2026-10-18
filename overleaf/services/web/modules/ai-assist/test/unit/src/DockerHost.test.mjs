import fs from 'node:fs'
import os from 'node:os'
import Path from 'node:path'
import { describe, it, beforeAll, afterAll } from 'vitest'
import { expect } from 'chai'
import {
  dockerHostGateway,
  isRunningInDocker,
  readDefaultGateway,
  resetDockerHostCache,
} from '../../../app/src/DockerHost.mjs'

const HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'

describe('DockerHost', function () {
  let dir

  beforeAll(function () {
    dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'dockerhost-test-'))
  })

  afterAll(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function routeTable(text) {
    const file = Path.join(dir, `route-${Math.random().toString(36).slice(2)}`)
    fs.writeFileSync(file, HEADER + text)
    return file
  }

  describe('readDefaultGateway', function () {
    it('reads the default gateway from a little-endian route table', function () {
      const file = routeTable(
        'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
          'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n'
      )
      expect(readDefaultGateway(file)).to.equal('172.17.0.1')
    })

    it('reads a gateway in the 172.20.0.0/16 range', function () {
      const file = routeTable(
        'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
      )
      expect(readDefaultGateway(file)).to.equal('172.20.0.1')
    })

    it('ignores routes that are not the default route', function () {
      const file = routeTable(
        'eth0\t0000FEA9\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n' +
          'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'
      )
      expect(readDefaultGateway(file)).to.equal('192.168.0.1')
    })

    it('returns null when there is no default route', function () {
      const file = routeTable(
        'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n'
      )
      expect(readDefaultGateway(file)).to.equal(null)
    })

    it('returns null when the route table cannot be read', function () {
      expect(readDefaultGateway(Path.join(dir, 'missing'))).to.equal(null)
    })
  })

  describe('cached answers', function () {
    it('caches the gateway until resetDockerHostCache', function () {
      resetDockerHostCache()
      const first = dockerHostGateway()
      expect(first).to.match(/^\d+\.\d+\.\d+\.\d+$/)
      expect(dockerHostGateway()).to.equal(first)
      resetDockerHostCache()
    })

    it('takes DOCKER_HOST_GATEWAY over the detected gateway', function () {
      const saved = process.env.DOCKER_HOST_GATEWAY
      process.env.DOCKER_HOST_GATEWAY = '10.9.8.7'
      resetDockerHostCache()
      try {
        expect(dockerHostGateway()).to.equal('10.9.8.7')
        expect(isRunningInDocker()).to.equal(true)
      } finally {
        if (saved === undefined) delete process.env.DOCKER_HOST_GATEWAY
        else process.env.DOCKER_HOST_GATEWAY = saved
        resetDockerHostCache()
      }
    })
  })
})
