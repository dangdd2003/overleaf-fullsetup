import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { Readable } from 'node:stream'

const {
  OutputTooLargeError,
  pipeBounded,
  readBounded,
} = await import('../../../../../app/src/Features/PdfInspection/BoundedStream.mjs')

describe('readBounded', () => {
  it('reads a stream whole when it is within the limit', async () => {
    const stream = Readable.from([Buffer.from('ab'), Buffer.from('cd')])
    const read = await readBounded(stream, 10)
    expect(read.buffer.toString()).toBe('abcd')
    expect(read.truncated).toBe(false)
  })

  it('stops at the limit and holds exactly the first bytes', async () => {
    const stream = Readable.from([Buffer.from('abcd'), Buffer.from('efgh')])
    const read = await readBounded(stream, 6)
    expect(read.buffer.toString()).toBe('abcdef')
    expect(read.truncated).toBe(true)
  })

  it('accepts strings as well as buffers', async () => {
    const read = await readBounded(Readable.from(['xy', 'z']), 10)
    expect(read.buffer.toString()).toBe('xyz')
  })
})

describe('pipeBounded', () => {
  let dir

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('copies a stream to the file within the limit', async () => {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'bounded-stream-'))
    const target = Path.join(dir, 'out.pdf')
    await pipeBounded(Readable.from([Buffer.from('%PDF-1.5')]), target, 100)
    expect(await fs.readFile(target, 'utf8')).toBe('%PDF-1.5')
  })

  it('refuses a stream past the limit', async () => {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'bounded-stream-'))
    const target = Path.join(dir, 'out.pdf')
    const stream = Readable.from([Buffer.alloc(8), Buffer.alloc(8)])
    let error = null
    try {
      await pipeBounded(stream, target, 10)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(OutputTooLargeError)
    expect(error.code).toBe('output_too_large')
  })
})
