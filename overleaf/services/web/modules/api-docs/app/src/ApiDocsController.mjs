import Path from 'node:path'
import Features from '../../../../app/src/infrastructure/Features.mjs'
import openApiSpec from './openapi.json' with { type: 'json' }
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserSettingsHelper from '../../../../app/src/Features/Project/UserSettingsHelper.mjs'
import { User } from '../../../../app/src/models/User.mjs'

// `x-feature` is a Features.mjs feature name, or a list of names when the
// endpoint is served if any one of them is enabled.
function isOperationVisible(operation) {
  const feature = operation['x-feature']
  if (!feature) {
    return true
  }
  return [feature].flat().some(name => Features.hasFeature(name))
}

// Every feature name that some operation is gated on
const featureNames = [
  ...new Set(
    Object.values(openApiSpec.paths)
      .flatMap(operations => Object.values(operations))
      .flatMap(operation => [operation['x-feature']].flat())
      .filter(Boolean)
  ),
]

// Visible spec per combination of enabled features; the spec is large, so
// rebuilding it on every request is wasteful
const visibleSpecs = new Map()

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

function cachedVisibleSpec() {
  const key = featureNames
    .map(name => (Features.hasFeature(name) ? '1' : '0'))
    .join('')
  if (!visibleSpecs.has(key)) {
    visibleSpecs.set(key, buildVisibleSpec())
  }
  return visibleSpecs.get(key)
}

const ApiDocsController = {
  async renderPage(req, res, next) {
    try {
      // Same theme inputs as the project dashboard, so light, dark and system
      // themes resolve identically on both pages
      const userId = SessionManager.getLoggedInUserId(req.session)
      const user = userId ? await User.findById(userId, 'ace').exec() : null
      const userSettings = user
        ? await UserSettingsHelper.buildUserSettings(req, res, user)
        : {}
      res.render(Path.resolve(import.meta.dirname, '../views/api-docs'), {
        userSettings,
        initialTheme: UserSettingsHelper.getInitialTheme(
          userSettings.overallTheme || ''
        ),
      })
    } catch (err) {
      if (typeof next === 'function') {
        next(err)
      } else {
        throw err
      }
    }
  },

  serveSpec(req, res) {
    res.json(cachedVisibleSpec())
  },
}

export default ApiDocsController
