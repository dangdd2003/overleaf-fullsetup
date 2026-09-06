import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createMcpServerFactory } from './server.js'

/**
 * Serve the tool surface on stdin/stdout for a single local user.
 *
 * stdout carries the JSON-RPC stream, so nothing here may console.log.
 *
 * @param {{ config: object, client: object }} deps
 */
export async function serveStdioTransport({ config, client }) {
  const factory = createMcpServerFactory({
    client,
    staticToken: config.stdioToken,
    maxUploadBytes: config.maxUploadBytes,
  })
  await serveStdio(factory)
}
