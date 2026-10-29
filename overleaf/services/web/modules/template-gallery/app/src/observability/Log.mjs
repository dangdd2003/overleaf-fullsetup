// overleaf/services/web/modules/template-gallery/app/src/observability/Log.mjs
import logger from '@overleaf/logger'
import metrics from '@overleaf/metrics'

function safeFields(fields) {
  if (fields && typeof fields === 'object') {
    return fields
  }
  return {}
}

export function logInfo(event, fields = {}) {
  const payload = safeFields(fields)
  if (typeof logger?.info === 'function') {
    logger.info(payload, `[TemplateGallery] ${event}`)
  }
}

export function logWarn(event, fields = {}) {
  const payload = safeFields(fields)
  if (typeof logger?.warn === 'function') {
    logger.warn(payload, `[TemplateGallery] ${event}`)
  }
}

export function logError(event, err, fields = {}) {
  const payload = { ...safeFields(fields), err }
  if (typeof logger?.error === 'function') {
    logger.error(payload, `[TemplateGallery] ${event}`)
  }
}

export function incMetric(name, labels = {}) {
  try {
    if (typeof metrics?.inc === 'function') {
      metrics.inc(`template_gallery_${name}`, labels)
    }
  } catch {
    // Ignore metrics failure in tests
  }
}

export function gaugeMetric(name, value, labels = {}) {
  try {
    if (typeof metrics?.gauge === 'function') {
      metrics.gauge(`template_gallery_${name}`, value, labels)
    }
  } catch {
    // Ignore metrics failure in tests
  }
}

export function timerMetric(name, labels = {}) {
  try {
    if (typeof metrics?.Timer === 'function') {
      return new metrics.Timer(`template_gallery_${name}`, labels)
    }
  } catch {
    // Fallback if Timer throws
  }
  return {
    done(_extraLabels = {}) {
      return 0
    },
  }
}

export default {
  logInfo,
  logWarn,
  logError,
  incMetric,
  gaugeMetric,
  timerMetric,
}
