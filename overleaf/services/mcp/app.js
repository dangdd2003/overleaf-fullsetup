import logger from '@overleaf/logger'
import { loadConfig } from './src/config.js'
import { createHttpApp } from './src/http.js'
import { OverleafClient } from './src/OverleafClient.js'
import { serveStdioTransport } from './src/stdio.js'

/**
 * Build the runnable application from a config object.
 *
 * Exported separately from the entrypoint so tests can assert the start-up
 * guards without binding a port.
 *
 * @param {object} config
 */
export function buildApp(config) {
  return {
    async start() {
      if (!config.enabled) {
        throw new Error(
          'the MCP service is disabled; set MCP_ENABLED=true to start it'
        )
      }
      const client = new OverleafClient({ baseUrl: config.internalUrl })

      if (config.transport === 'stdio') {
        await serveStdioTransport({ config, client })
        return
      }
      if (config.transport !== 'http') {
        throw new Error(`unsupported transport "${config.transport}"`)
      }

      const { app } = createHttpApp({ config, client })
      await new Promise((resolve, reject) => {
        const server = app.listen(config.port, config.host, err =>
          err ? reject(err) : resolve(server)
        )
        server.on('error', reject)
      })
      logger.info(
        { host: config.host, port: config.port, endpoint: config.endpointPath },
        'Overleaf MCP service listening'
      )
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildApp(loadConfig())
    .start()
    .catch(err => {
      logger.fatal({ err }, 'Overleaf MCP service failed to start')
      process.exit(1)
    })
}
