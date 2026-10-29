// overleaf/services/web/modules/template-gallery/app/src/validation/SandboxGate.mjs

/**
 * Validates sandbox enforcement policy for template compilation.
 *
 * Export check(settings, runtime):
 * - returns { ok: true, mode: "enforced" } if settings?.validation?.sandboxEnforced === true
 * - returns { ok: true, mode: "acknowledged-unsandboxed" } if settings?.validation?.allowUnsandboxedAck === true && runtime?.unsandboxedAck?.at
 * - otherwise { ok: false, code: "sandbox-not-enforced" }
 */
export function check(settings, runtime) {
  if (settings?.validation?.sandboxEnforced === true) {
    return { ok: true, mode: 'enforced' }
  }

  if (
    settings?.validation?.allowUnsandboxedAck === true &&
    runtime?.unsandboxedAck?.at
  ) {
    return { ok: true, mode: 'acknowledged-unsandboxed' }
  }

  return {
    ok: false,
    code: 'sandbox-not-enforced',
  }
}

export default {
  check,
}
