import Path from 'node:path'
import Features from '../../../../app/src/infrastructure/Features.mjs'
import openApiSpec from './openapi.json' with { type: 'json' }

// `x-feature` is a Features.mjs feature name, or a list of names when the
// endpoint is served if any one of them is enabled.
function isOperationVisible(operation) {
  const feature = operation['x-feature']
  if (!feature) {
    return true
  }
  return [feature].flat().some(name => Features.hasFeature(name))
}

function buildVisibleSpec() {
  const paths = Object.fromEntries(
    Object.entries(openApiSpec.paths)
      .map(([path, operations]) => [
        path,
        Object.fromEntries(
          Object.entries(operations).filter(([, operation]) =>
            isOperationVisible(operation)
          )
        ),
      ])
      .filter(([, operations]) => Object.keys(operations).length > 0)
  )
  return { ...openApiSpec, paths }
}

const ApiDocsController = {
  renderPage(req, res) {
    res.render(Path.resolve(import.meta.dirname, '../views/api-docs'))
  },

  serveSpec(req, res) {
    res.json(buildVisibleSpec())
  },
}

export default ApiDocsController
