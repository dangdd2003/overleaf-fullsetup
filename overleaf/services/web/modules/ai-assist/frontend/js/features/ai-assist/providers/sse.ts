export type SseFrame = { event: string | null; data: string }

/**
 * What a fetch implementation may hand back as a response body: a browser's
 * ReadableStream, a Node stream, or — under the frontend test runner's
 * node-fetch — an already-buffered body.
 */
export type SseBody =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Uint8Array
  | string

/**
 * Yields the raw chunks of a response body.
 *
 * A browser gives a WHATWG ReadableStream; node-fetch, which the frontend test
 * runner installs as global fetch, gives a Node stream that is async-iterable
 * instead. Accepting both keeps the tests exercising this code rather than a
 * substitute.
 */
async function* bodyChunks(
  stream: SseBody
): AsyncGenerator<Uint8Array> {
  // A whole buffer, not a stream. Checked before the async-iterable branch
  // because iterating a Uint8Array yields one byte number at a time, which the
  // decoder rejects.
  if (stream instanceof Uint8Array) {
    yield stream
    return
  }

  if (typeof stream === 'string') {
    yield new TextEncoder().encode(stream)
    return
  }

  const readable = stream as ReadableStream<Uint8Array>
  if (typeof readable.getReader !== 'function') {
    yield* stream as AsyncIterable<Uint8Array>
    return
  }

  const reader = readable.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parses an SSE body into frames.
 *
 * Both wire formats are read straight from the provider now, so this has to
 * carry the `event:` line as well as `data:` — the Anthropic format puts the
 * frame type there, unlike the OpenAI format which is data-only. A frame split
 * across chunk boundaries is reassembled; a malformed one is skipped rather than
 * ending the stream.
 */
export async function* parseSseFrames(
  stream: SseBody
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of bodyChunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')

    let boundary
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      let event: string | null = null
      const dataLines: string[] = []

      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }

      if (dataLines.length) yield { event, data: dataLines.join('\n') }
    }
  }
}

/**
 * Parses an NDJSON (newline-delimited JSON) stream into individual line strings.
 * Used for Ollama's native streaming endpoint (/api/chat).
 */
export async function* parseNdjsonLines(
  stream: SseBody
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of bodyChunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')

    let boundary: number
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      if (line) yield line
    }
  }

  if (buffer.trim()) {
    yield buffer.trim()
  }
}

