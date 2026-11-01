import { ChangeEvent, FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Notification from '@/shared/components/notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLTable from '@/shared/components/ol/ol-table'
import {
  addProxiesBulk,
  createEgressProxy,
  deleteEgressProxy,
  EgressBulkLineError,
  EgressConfig,
  EgressProbeResult,
  EgressProxy,
  EgressProxyInput,
  EgressScheme,
  getEgress,
  setEgressDirect,
  testEgressProxy,
  updateEgressProxy,
} from '../../../api/egress'
import { errorMessage, toTemplateAdminApiError } from '../../../api/errors'
import { useAsyncAction } from '../../../hooks/use-async-action'
import { ConfirmActionModal } from '../../shared/confirm-action-modal'
import type { Flash } from '../../shared/flash'
import SectionCard from '../../shared/section-card'

// Logins are kept in the form state only until the proxy is saved. They are
// never rendered back, logged or included in an error message.
const MAX_PORT = 65535
const MAX_LABEL_LENGTH = 60
const MAX_HOST_LENGTH = 253
const SCHEMES: EgressScheme[] = ['http', 'https', 'socks5', 'socks5h']

type EgressCardProps = {
  onFlash(flash: Flash): void
}

type ProbeState = { result: EgressProbeResult } | { error: string }

type BulkLineError = EgressBulkLineError

// Keeps only the addresses the server rejected, in the same order and with the
// same line rules as the server, so accepted addresses are not sent again.
function rejectedText(text: string, errors: BulkLineError[]): string {
  const rejectedPositions = new Set(
    errors
      .filter(error => typeof error.position === 'number')
      .map(error => error.position)
  )
  const rejectedLines = new Set(
    errors
      .filter(error => typeof error.position !== 'number')
      .map(error => error.line)
  )
  const lines: string[] = []
  let position = 0
  const rawLines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index].trim()
    if (!line || line.startsWith('#')) continue
    const lineNumber = index + 1
    const kept: string[] = []
    for (const part of line.split(',')) {
      const token = part.trim()
      if (!token) continue
      if (rejectedPositions.has(position) || rejectedLines.has(lineNumber)) {
        kept.push(token)
      }
      position += 1
    }
    if (kept.length > 0) lines.push(kept.join(','))
  }
  return lines.join('\n')
}

const EMPTY_FORM = {
  label: '',
  scheme: 'socks5' as EgressScheme,
  host: '',
  port: '',
  username: '',
  password: '',
  allowPrivate: false,
}

function addressOf(proxy: EgressProxy): string {
  return `${proxy.scheme}://${proxy.host}:${proxy.port}`
}

function statusKey(proxy: EgressProxy): string {
  return proxy.enabled
    ? `template_gallery_admin_egress_status_${proxy.health.state}`
    : 'template_gallery_admin_egress_status_off'
}

export default function EgressCard({ onFlash }: EgressCardProps) {
  const { t } = useTranslation()
  const idPrefix = useId()
  const [config, setConfig] = useState<EgressConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [confirmDelete, setConfirmDelete] = useState<EgressProxy | null>(null)
  const directAction = useAsyncAction()
  const rowAction = useAsyncAction()
  const addAction = useAsyncAction()
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkAllowPrivate, setBulkAllowPrivate] = useState(false)
  const [bulkErrors, setBulkErrors] = useState<BulkLineError[]>([])
  const bulkAction = useAsyncAction()
  // The proxy being tested, if any. Only one test runs at a time.
  const [testingId, setTestingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setConfig(await getEgress())
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(t, toTemplateAdminApiError(err)))
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  const enabledCount = config?.proxies.filter(proxy => proxy.enabled).length ?? 0

  function setField<K extends keyof typeof EMPTY_FORM>(
    key: K,
    value: (typeof EMPTY_FORM)[K]
  ) {
    setForm(current => ({ ...current, [key]: value }))
  }

  const portNumber = Number(form.port)
  const formValid =
    form.host.trim() !== '' &&
    form.host.trim().length <= MAX_HOST_LENGTH &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= MAX_PORT &&
    form.label.trim().length <= MAX_LABEL_LENGTH

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!formValid || addAction.busy) return
    const input: EgressProxyInput = {
      label: form.label.trim(),
      scheme: form.scheme,
      host: form.host.trim(),
      port: portNumber,
      allowPrivate: form.allowPrivate,
    }
    if (form.username.trim() || form.password) {
      input.username = form.username.trim()
      input.password = form.password
    }
    void addAction.run(async () => {
      await createEgressProxy(input)
      setForm(current => ({ ...EMPTY_FORM, scheme: current.scheme }))
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_egress_added'),
      })
      await reload()
    })
  }

  // Only the rejected addresses stay in the textarea, so the admin can fix them
  // without resubmitting the ones that were saved. Line numbers are 1-based
  // positions in the submitted text.
  function handleBulkAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!bulkText.trim() || bulkAction.busy) return
    const submitted = bulkText
    void bulkAction.run(async () => {
      const result = await addProxiesBulk(submitted, bulkAllowPrivate)
      const errors = result.errors
      setBulkErrors(errors)
      setBulkText(rejectedText(submitted, errors))
      if (result.added.length > 0) {
        onFlash({
          type: 'success',
          content: t('template_gallery_admin_egress_bulk_added', {
            count: result.added.length,
          }),
        })
      }
      await reload()
    })
  }

  function toggleBulkMode() {
    setBulkMode(!bulkMode)
    setBulkErrors([])
    bulkAction.clearError()
    addAction.clearError()
  }

  function bulkLineReason(code: string): string {
    return t(`template_gallery_admin_egress_bulk_error_${code}`, {
      defaultValue: t('template_gallery_admin_egress_bulk_error_unknown'),
    })
  }

  function toggleDirect(useDirect: boolean) {
    void directAction.run(async () => {
      await setEgressDirect(useDirect)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_egress_saved'),
      })
      await reload()
    })
  }

  function toggleProxy(proxy: EgressProxy) {
    void rowAction.run(async () => {
      await updateEgressProxy(proxy.id, { enabled: !proxy.enabled })
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_egress_saved'),
      })
      await reload()
    })
  }

  async function removeProxy() {
    if (!confirmDelete) return
    const id = confirmDelete.id
    const removed = await rowAction.run(async () => {
      await deleteEgressProxy(id)
      setProbes(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      await reload()
      return true
    })
    if (removed) {
      setConfirmDelete(null)
      onFlash({
        type: 'success',
        content: t('template_gallery_admin_egress_deleted'),
      })
    }
  }

  function hideDeleteModal() {
    setConfirmDelete(null)
    rowAction.clearError()
  }

  async function testProxy(proxy: EgressProxy) {
    setTestingId(proxy.id)
    let probe: ProbeState
    try {
      probe = { result: await testEgressProxy(proxy.id) }
    } catch (err) {
      probe = { error: errorMessage(t, toTemplateAdminApiError(err)) }
    }
    setTestingId(null)
    setProbes(current => ({ ...current, [proxy.id]: probe }))
  }

  function probeText(probe: ProbeState): string {
    if ('error' in probe) {
      return probe.error
    }
    const { result } = probe
    if (result.ok) {
      return t('template_gallery_admin_egress_test_ok', {
        status: result.status,
        latency: result.latencyMs,
      })
    }
    if (result.error === 'upstream_blocked') {
      return t('template_gallery_admin_egress_test_blocked', {
        status: result.status,
      })
    }
    return t(`template_gallery_admin_egress_test_error_${result.error}`, {
      defaultValue: t('template_gallery_admin_egress_test_failed'),
    })
  }

  if (!config) {
    return (
      <SectionCard title={t('template_gallery_admin_egress_title')}>
        {loadError ? (
          <Notification type="error" content={loadError} />
        ) : (
          <p className="text-muted mb-0">
            {t('template_gallery_admin_egress_loading')}
          </p>
        )}
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title={t('template_gallery_admin_egress_title')}
      actions={
        enabledCount > 0 ? (
          <OLBadge bg="primary">
            {t('template_gallery_admin_egress_badge_enabled', {
              count: enabledCount,
            })}
          </OLBadge>
        ) : (
          <OLBadge bg="transparent" text="body" className="border">
            {t('template_gallery_admin_egress_badge_direct_only')}
          </OLBadge>
        )
      }
    >
      <p className="text-muted">{t('template_gallery_admin_egress_help')}</p>

      {directAction.error && (
        <Notification
          type="error"
          content={errorMessage(t, directAction.error)}
          className="mb-3"
        />
      )}
      {rowAction.error && !confirmDelete && (
        <Notification
          type="error"
          content={errorMessage(t, rowAction.error)}
          className="mb-3"
        />
      )}

      <OLFormCheckbox
        id={`${idPrefix}-direct`}
        label={t('template_gallery_admin_egress_direct_label')}
        checked={config.useDirect}
        disabled={directAction.busy}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          toggleDirect(e.target.checked)
        }
      />

      {config.proxies.length > 0 && (
        <OLTable
          container={false}
          hover
          className="mt-3 mb-0 align-middle"
        >
          <caption className="visually-hidden">
            {t('template_gallery_admin_egress_title')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('template_gallery_admin_egress_col_name')}</th>
              <th scope="col">{t('template_gallery_admin_egress_col_address')}</th>
              <th scope="col">{t('template_gallery_admin_egress_col_login')}</th>
              <th scope="col">{t('template_gallery_admin_egress_col_status')}</th>
              <th scope="col">
                <span className="visually-hidden">
                  {t('template_gallery_admin_egress_col_actions')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {config.proxies.map(proxy => {
              const probe = probes[proxy.id]
              return (
                <tr key={proxy.id}>
                  <td>{proxy.label}</td>
                  <td>
                    <code>{addressOf(proxy)}</code>
                  </td>
                  <td>
                    {proxy.hasAuth
                      ? t('template_gallery_admin_egress_yes')
                      : t('template_gallery_admin_egress_no')}
                  </td>
                  <td>
                    <div>{t(statusKey(proxy))}</div>
                    {probe && (
                      <small className="text-muted d-block">
                        {probeText(probe)}
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="d-flex justify-content-end gap-2 flex-wrap">
                      <OLButton
                        variant="secondary"
                        size="sm"
                        disabled={testingId !== null}
                        isLoading={testingId === proxy.id}
                        onClick={() => void testProxy(proxy)}
                      >
                        {t('template_gallery_admin_egress_action_test')}
                      </OLButton>
                      <OLButton
                        variant="secondary"
                        size="sm"
                        disabled={rowAction.busy}
                        onClick={() => toggleProxy(proxy)}
                      >
                        {proxy.enabled
                          ? t('template_gallery_admin_egress_action_disable')
                          : t('template_gallery_admin_egress_action_enable')}
                      </OLButton>
                      <OLButton
                        variant="danger"
                        size="sm"
                        disabled={rowAction.busy}
                        onClick={() => setConfirmDelete(proxy)}
                      >
                        {t('template_gallery_admin_egress_action_delete')}
                      </OLButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </OLTable>
      )}
      {config.proxies.length === 0 && (
        <p className="text-muted mt-3 mb-0">
          {t('template_gallery_admin_egress_empty')}
        </p>
      )}

      <div className="d-flex justify-content-between align-items-center mt-4 mb-2">
        <h3 className="h6 mb-0">{t('template_gallery_admin_egress_add_title')}</h3>
        <OLButton
          variant="link"
          size="sm"
          disabled={addAction.busy || bulkAction.busy}
          onClick={toggleBulkMode}
        >
          {bulkMode
            ? t('template_gallery_admin_egress_single_open')
            : t('template_gallery_admin_egress_bulk_open')}
        </OLButton>
      </div>
      {!bulkMode && addAction.error && (
        <Notification
          type="error"
          content={errorMessage(t, addAction.error)}
          className="mb-3"
        />
      )}
      {bulkMode && (
        <OLForm onSubmit={handleBulkAdd}>
          {bulkAction.error && (
            <Notification
              type="error"
              content={errorMessage(t, bulkAction.error)}
              className="mb-3"
            />
          )}
          {bulkErrors.length > 0 && (
            <Notification
              type="warning"
              className="mb-3"
              content={
                <ul className="mb-0 ps-3">
                  {bulkErrors.map((error, index) => (
                    <li key={error.position ?? `${error.line}-${index}`}>
                      {t('template_gallery_admin_egress_bulk_line', {
                        line: error.line,
                        input: error.input,
                        reason: bulkLineReason(error.error),
                      })}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          <OLFormGroup>
            <OLFormLabel htmlFor={`${idPrefix}-bulk-text`}>
              {t('template_gallery_admin_egress_bulk_field')}
            </OLFormLabel>
            <OLFormControl
              id={`${idPrefix}-bulk-text`}
              as="textarea"
              rows={6}
              className="font-monospace"
              spellCheck={false}
              autoComplete="off"
              placeholder={t(
                'template_gallery_admin_egress_bulk_placeholder'
              )}
              aria-describedby={`${idPrefix}-bulk-help`}
              value={bulkText}
              disabled={bulkAction.busy}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setBulkText(e.target.value)
              }
            />
            <small
              className="text-muted d-block mt-2"
              id={`${idPrefix}-bulk-help`}
            >
              {t('template_gallery_admin_egress_bulk_help')}
            </small>
          </OLFormGroup>
          <OLFormCheckbox
            id={`${idPrefix}-bulk-private`}
            label={t('template_gallery_admin_egress_bulk_allow_private')}
            checked={bulkAllowPrivate}
            disabled={bulkAction.busy}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setBulkAllowPrivate(e.target.checked)
            }
          />
          <div className="d-flex justify-content-end mt-3">
            <OLButton
              type="submit"
              variant="primary"
              disabled={!bulkText.trim()}
              isLoading={bulkAction.busy}
            >
              {t('template_gallery_admin_egress_bulk_submit')}
            </OLButton>
          </div>
        </OLForm>
      )}
      {!bulkMode && (
        <OLForm onSubmit={handleAdd}>
          <div className="row">
            <OLFormGroup className="col-md-6">
              <OLFormLabel htmlFor={`${idPrefix}-label`}>
                {t('template_gallery_admin_egress_field_name')}
              </OLFormLabel>
              <OLFormControl
                id={`${idPrefix}-label`}
                maxLength={MAX_LABEL_LENGTH}
                value={form.label}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setField('label', e.target.value)
                }
              />
            </OLFormGroup>
            <OLFormGroup className="col-md-6">
              <OLFormLabel htmlFor={`${idPrefix}-scheme`}>
                {t('template_gallery_admin_egress_field_type')}
              </OLFormLabel>
              <OLFormSelect
                id={`${idPrefix}-scheme`}
                value={form.scheme}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setField('scheme', e.target.value as EgressScheme)
                }
              >
                {SCHEMES.map(scheme => (
                  <option key={scheme} value={scheme}>
                    {t(`template_gallery_admin_egress_type_${scheme}`)}
                  </option>
                ))}
              </OLFormSelect>
            </OLFormGroup>
            <OLFormGroup className="col-md-8">
              <OLFormLabel htmlFor={`${idPrefix}-host`}>
                {t('template_gallery_admin_egress_field_host')}
              </OLFormLabel>
              <OLFormControl
                id={`${idPrefix}-host`}
                required
                maxLength={MAX_HOST_LENGTH}
                value={form.host}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setField('host', e.target.value)
                }
              />
            </OLFormGroup>
            <OLFormGroup className="col-md-4">
              <OLFormLabel htmlFor={`${idPrefix}-port`}>
                {t('template_gallery_admin_egress_field_port')}
              </OLFormLabel>
              <OLFormControl
                id={`${idPrefix}-port`}
                type="number"
                min={1}
                max={MAX_PORT}
                step={1}
                required
                value={form.port}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setField('port', e.target.value)
                }
              />
            </OLFormGroup>
            <OLFormGroup className="col-md-6">
              <OLFormLabel htmlFor={`${idPrefix}-username`}>
                {t('template_gallery_admin_egress_field_username')}
              </OLFormLabel>
              <OLFormControl
                id={`${idPrefix}-username`}
                autoComplete="off"
                value={form.username}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setField('username', e.target.value)
                }
              />
            </OLFormGroup>
            <OLFormGroup className="col-md-6">
              <OLFormLabel htmlFor={`${idPrefix}-password`}>
                {t('template_gallery_admin_egress_field_password')}
              </OLFormLabel>
              <OLFormControl
                id={`${idPrefix}-password`}
                type="password"
                autoComplete="new-password"
                aria-describedby={`${idPrefix}-password-help`}
                value={form.password}
                disabled={addAction.busy}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setField('password', e.target.value)
                }
              />
              <small className="text-muted d-block mt-2" id={`${idPrefix}-password-help`}>
                {t('template_gallery_admin_egress_help_http_login')}
              </small>
            </OLFormGroup>
          </div>
          <OLFormCheckbox
            id={`${idPrefix}-private`}
            label={t('template_gallery_admin_egress_field_allow_private')}
            checked={form.allowPrivate}
            disabled={addAction.busy}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setField('allowPrivate', e.target.checked)
            }
          />
          <div className="d-flex justify-content-end mt-3">
            <OLButton
              type="submit"
              variant="primary"
              disabled={!formValid}
              isLoading={addAction.busy}
            >
              {t('template_gallery_admin_egress_add')}
            </OLButton>
          </div>
        </OLForm>
      )}

      <ConfirmActionModal
        show={confirmDelete !== null}
        title={t('template_gallery_admin_egress_confirm_delete_title')}
        body={t('template_gallery_admin_egress_confirm_delete_body')}
        confirmLabel={t('template_gallery_admin_egress_action_delete')}
        variant="danger"
        busy={rowAction.busy}
        error={rowAction.error}
        onConfirm={removeProxy}
        onHide={hideDeleteModal}
      />
    </SectionCard>
  )
}
