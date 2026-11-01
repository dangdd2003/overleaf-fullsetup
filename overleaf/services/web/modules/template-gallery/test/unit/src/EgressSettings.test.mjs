import Settings from '@overleaf/settings'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { createFakeCollection } from './S-P4-support.mjs'
import * as EgressSettings from '../../../app/src/egress/EgressSettings.mjs'
import { decryptSecret } from '../../../app/src/crypto/SecretBox.mjs'
import { isTransientCode } from '../../../app/src/transport/HostLimiter.mjs'

const GOOD = {
  label: 'office',
  scheme: 'socks5',
  host: 'proxy.example.net',
  port: 1080,
  username: 'alice',
  password: 'hunter2-plain',
}

async function codeOf(promise) {
  try {
    await promise
  } catch (err) {
    return err.code
  }
  throw new Error('expected rejection')
}

describe('EgressSettings', () => {
  let col
  beforeEach(async () => {
    col = createFakeCollection()
    setCollectionOverrideForTests({ templateGalleryConfig: col })
    Settings.security = { sessionSecret: 'unit-test-session-secret' }
    EgressSettings.resetEgressSettingsForTests()
    await EgressSettings.refresh()
  })
  afterEach(() => {
    setCollectionOverrideForTests(null)
    delete Settings.security
    EgressSettings.resetEgressSettingsForTests()
  })

  it('defaults to direct only when no document exists', async () => {
    const view = await EgressSettings.view()
    expect(view).toEqual({ useDirect: true, proxies: [] })
    expect(EgressSettings.snapshot()).toEqual({ useDirect: true, egresses: [] })
  })

  it('stores the login encrypted and never the plaintext password', async () => {
    const { proxy } = await EgressSettings.createProxy(GOOD)
    const raw = JSON.stringify(col.docs)
    expect(raw).not.toContain('hunter2-plain')
    expect(raw).not.toContain('alice')
    expect(proxy.id).toMatch(/^px_[0-9a-f]{12}$/)
    expect(decryptSecret(col.docs[0].proxies[0].authEnc)).toContain('hunter2-plain')
  })

  it('view() carries hasAuth only and no secrets', async () => {
    await EgressSettings.createProxy(GOOD)
    const view = await EgressSettings.view()
    expect(view.proxies[0].hasAuth).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/hunter2|alice|authEnc/)
  })

  it('snapshot() exposes the decrypted login of enabled proxies', async () => {
    await EgressSettings.createProxy(GOOD)
    await EgressSettings.refresh()
    const { egresses } = EgressSettings.snapshot()
    expect(egresses).toHaveLength(1)
    expect(egresses[0]).toMatchObject({ username: 'alice', password: 'hunter2-plain' })
  })

  it('keeps the stored password when omitted and clears it on an empty string', async () => {
    const { proxy } = await EgressSettings.createProxy(GOOD)
    await EgressSettings.updateProxy(proxy.id, { label: 'renamed' })
    await EgressSettings.refresh()
    expect(EgressSettings.snapshot().egresses[0].password).toBe('hunter2-plain')

    await EgressSettings.updateProxy(proxy.id, { password: '' })
    await EgressSettings.refresh()
    const cleared = EgressSettings.snapshot().egresses[0]
    expect(cleared.password).toBeNull()
    expect(cleared.username).toBeNull()
    expect((await EgressSettings.view()).proxies[0].hasAuth).toBe(false)
  })

  it('validates scheme, port, host and label', async () => {
    expect(await codeOf(EgressSettings.createProxy({ ...GOOD, scheme: 'ftp' }))).toBe('invalid_scheme')
    expect(await codeOf(EgressSettings.createProxy({ ...GOOD, port: 0 }))).toBe('invalid_port')
    expect(await codeOf(EgressSettings.createProxy({ ...GOOD, port: 65536 }))).toBe('invalid_port')
    expect(await codeOf(EgressSettings.createProxy({ ...GOOD, host: 'bad host/x' }))).toBe('invalid_host')
    expect(await codeOf(EgressSettings.createProxy({ ...GOOD, label: 'x'.repeat(61) }))).toBe('invalid_label')
    expect(col.docs.length).toBe(0)
  })

  it('refuses a metadata address as the proxy host', async () => {
    expect(
      await codeOf(EgressSettings.createProxy({ ...GOOD, host: '169.254.169.254' }))
    ).toBe('invalid_host')
  })

  it('allows a private host only when allowPrivate is set', async () => {
    const { proxy } = await EgressSettings.createProxy({ ...GOOD, host: '10.1.2.3', allowPrivate: true })
    expect(proxy.allowPrivate).toBe(true)
  })

  it('caps the list at 20 proxies', async () => {
    for (let i = 0; i < EgressSettings.MAX_PROXIES; i++) {
      await EgressSettings.createProxy({
        ...GOOD,
        host: `p${i}.example.net`,
        username: '',
        password: '',
      })
    }
    expect(
      await codeOf(
        EgressSettings.createProxy({
          ...GOOD,
          host: 'p20.example.net',
          username: '',
          password: '',
        })
      )
    ).toBe('proxy_limit')
  })

  it('rejects duplicate endpoints on createProxy and updateProxy', async () => {
    await EgressSettings.createProxy({
      ...GOOD,
      host: 'dup.example.net',
      username: '',
      password: '',
    })
    expect(
      await codeOf(
        EgressSettings.createProxy({
          ...GOOD,
          host: 'DUP.example.net',
          username: '',
          password: '',
        })
      )
    ).toBe('duplicate')
    const { proxy: second } = await EgressSettings.createProxy({
      ...GOOD,
      host: 'other.example.net',
      username: '',
      password: '',
    })
    expect(
      await codeOf(
        EgressSettings.updateProxy(second.id, { host: 'dup.example.net' })
      )
    ).toBe('duplicate')
  })

  it('refuses to store a login when no session secret is configured', async () => {
    delete Settings.security
    expect(await codeOf(EgressSettings.createProxy(GOOD))).toBe('secret_not_configured')
    expect(col.docs.length).toBe(0)
  })

  it('refuses a state with no usable egress', async () => {
    const { proxy } = await EgressSettings.createProxy({ ...GOOD, username: '', password: '' })
    expect((await EgressSettings.setUseDirect(false)).useDirect).toBe(false)
    expect(await codeOf(EgressSettings.deleteProxy(proxy.id))).toBe('no_egress')
    expect(await codeOf(EgressSettings.updateProxy(proxy.id, { enabled: false }))).toBe('no_egress')
  })

  it('updates and deletes by id, reporting not_found for unknown ids', async () => {
    const { proxy } = await EgressSettings.createProxy(GOOD)
    await EgressSettings.deleteProxy(proxy.id)
    expect(await codeOf(EgressSettings.deleteProxy(proxy.id))).toBe('not_found')
    expect(await codeOf(EgressSettings.updateProxy('px_000000000000', { label: 'x' }))).toBe('not_found')
  })

  it('writes with a version compare-and-set', async () => {
    await EgressSettings.createProxy(GOOD)
    expect(col.docs[0].version).toBe(1)
    await EgressSettings.setUseDirect(true)
    expect(col.docs[0].version).toBe(2)
  })

  it('reports a version_conflict when the document changed under the write', async () => {
    await EgressSettings.createProxy(GOOD)
    const original = col.updateOne
    col.updateOne = async (filter, update, options) => {
      col.updateOne = original
      col.docs[0].version += 1
      return original.call(col, filter, update, options)
    }
    expect(await codeOf(EgressSettings.setUseDirect(true))).toBe('version_conflict')
  })

  it('bulk-adds one proxy per line in a single write', async () => {
    const text = [
      '# office proxies',
      '',
      'http://10.0.0.1:3128#lab',
      'https://secure.example.net',
      'socks://alice:p%40ss@socks.example.net:1080',
      'socks5h://a.example.net:1081, socks5://b.example.net:1082',
    ].join('\n')
    const { added, errors } = await EgressSettings.createProxiesFromText(text, { allowPrivate: true })
    expect(errors).toEqual([])
    expect(added.map(proxy => [proxy.scheme, proxy.host, proxy.port, proxy.label])).toEqual([
      ['http', '10.0.0.1', 3128, 'lab'],
      ['https', 'secure.example.net', 443, 'secure.example.net'],
      ['socks5', 'socks.example.net', 1080, 'socks.example.net'],
      ['socks5h', 'a.example.net', 1081, 'a.example.net'],
      ['socks5', 'b.example.net', 1082, 'b.example.net'],
    ])
    expect(added[0].allowPrivate).toBe(true)
    expect(added[0].hasAuth).toBe(false)
    expect(added[2].hasAuth).toBe(true)
    expect(col.docs[0].version).toBe(1)
    expect(col.docs[0].proxies).toHaveLength(5)
    await EgressSettings.refresh()
    expect(EgressSettings.snapshot().egresses.find(e => e.host === 'socks.example.net')).toMatchObject({
      username: 'alice',
      password: 'p@ss',
    })
  })

  it('reports bad lines with their number, codes and a hidden password', async () => {
    const text = [
      'ftp://files.example.net:21',
      'notaurl',
      'socks5://socks.example.net',
      'http://169.254.169.254:80',
      'http://bob:hunter9@ok.example.net:8080',
      'http://u:%zz@bad-login.example.net:80',
    ].join('\n')
    delete Settings.security
    const { added, errors } = await EgressSettings.createProxiesFromText(text)
    expect(added).toEqual([])
    expect(errors).toEqual([
      { line: 1, position: 0, input: 'ftp://files.example.net:21', error: 'invalid_scheme' },
      { line: 2, position: 1, input: 'notaurl', error: 'invalid_url' },
      { line: 3, position: 2, input: 'socks5://socks.example.net', error: 'invalid_port' },
      { line: 4, position: 3, input: 'http://169.254.169.254:80', error: 'invalid_host' },
      { line: 5, position: 4, input: 'http://bob:***@ok.example.net:8080', error: 'secret_not_configured' },
      { line: 6, position: 5, input: 'http://u:***@bad-login.example.net:80', error: 'invalid_login' },
    ])
    expect(JSON.stringify(errors)).not.toContain('hunter9')
  })

  it('rejects a bulk line with a login when no session secret is configured, keeps the others', async () => {
    delete Settings.security
    const { added, errors } = await EgressSettings.createProxiesFromText(
      'http://bob:hunter9@a.example.net:80\nhttp://b.example.net:80'
    )
    expect(added.map(proxy => proxy.host)).toEqual(['b.example.net'])
    expect(errors).toEqual([
      { line: 1, position: 0, input: 'http://bob:***@a.example.net:80', error: 'secret_not_configured' },
    ])
  })

  it('skips duplicates of existing proxies and of earlier lines', async () => {
    await EgressSettings.createProxy({ ...GOOD, host: 'dup.example.net', port: 1080, username: '', password: '' })
    const text = [
      'socks5://DUP.example.net:1080',
      'socks5://dup.example.net:1081',
      'socks5://dup.example.net:1081',
      'socks5h://dup.example.net:1081',
    ].join('\n')
    const { added, errors } = await EgressSettings.createProxiesFromText(text)
    expect(added.map(proxy => `${proxy.scheme}:${proxy.port}`)).toEqual([
      'socks5:1081',
      'socks5h:1081',
    ])
    expect(errors).toEqual([
      { line: 1, position: 0, input: 'socks5://DUP.example.net:1080', error: 'duplicate' },
      { line: 3, position: 2, input: 'socks5://dup.example.net:1081', error: 'duplicate' },
    ])
  })

  it('stops at the 20-proxy limit and reports the rest', async () => {
    for (let i = 0; i < EgressSettings.MAX_PROXIES - 1; i++) {
      await EgressSettings.createProxy({ ...GOOD, host: `p${i}.example.net`, username: '', password: '' })
    }
    const { added, errors } = await EgressSettings.createProxiesFromText(
      'http://x1.example.net:80\nhttp://x2.example.net:80\nhttp://x3.example.net:80'
    )
    expect(added).toHaveLength(1)
    expect(errors).toEqual([
      { line: 2, position: 1, input: 'http://x2.example.net:80', error: 'proxy_limit' },
      { line: 3, position: 2, input: 'http://x3.example.net:80', error: 'proxy_limit' },
    ])
    expect((await EgressSettings.view()).proxies).toHaveLength(EgressSettings.MAX_PROXIES)
  })

  it('writes nothing when no line is valid', async () => {
    const { added, errors } = await EgressSettings.createProxiesFromText('ftp://x.example.net:21')
    expect(added).toEqual([])
    expect(errors).toHaveLength(1)
    expect(col.docs.length).toBe(0)
  })

  it('refuses a non-string or oversized text and a non-boolean allowPrivate', async () => {
    expect(await codeOf(EgressSettings.createProxiesFromText(42))).toBe('invalid_text')
    expect(await codeOf(EgressSettings.createProxiesFromText('a'.repeat(20 * 1024 + 1)))).toBe('invalid_text')
    expect(await codeOf(EgressSettings.createProxiesFromText('', { allowPrivate: 'yes' }))).toBe('invalid_flag')
  })

  it('isTransientCode treats EPROXY_* as transient', () => {
    expect(isTransientCode('EPROXY_UNREACHABLE')).toBe(true)
    expect(isTransientCode('EPROXY_AUTH')).toBe(true)
  })

  it('reports an address with spaces as one invalid line instead of splitting it', async () => {
    const res = await EgressSettings.createProxiesFromText(
      'http://not a url\nsocks5://8.8.8.8:1080, socks5://8.8.4.4:1080'
    )
    expect(res.errors).toEqual([
      { line: 1, position: 0, input: 'http://not a url', error: 'invalid_url' },
    ])
    expect(res.added.map(proxy => proxy.host)).toEqual(['8.8.8.8', '8.8.4.4'])
  })

  it('accepts a single-label host only for a private-network proxy', async () => {
    const res = await EgressSettings.createProxiesFromText('http://squid:3128')
    expect(res.errors[0]).toMatchObject({ error: 'invalid_host' })
    const allowed = await EgressSettings.createProxiesFromText(
      'http://squid:3128',
      { allowPrivate: true }
    )
    expect(allowed.added).toHaveLength(1)
  })
})
