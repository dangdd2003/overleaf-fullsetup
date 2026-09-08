import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import { useLocation } from '@/shared/hooks/use-location'
import getMeta from '@/utils/meta'

type Repo = {
  name: string
  owner: { login: string }
  private: boolean
  default_branch: string
  empty: boolean
}

type Props = { onHide: () => void }

export default function NewProjectGithubModalWrapper({ onHide }: Props) {
  if (!getMeta('ol-githubSyncEnabled')) return null
  return <NewProjectGithubModalWrapperInner onHide={onHide} />
}

function NewProjectGithubModalWrapperInner({ onHide }: Props) {
  const { t } = useTranslation()
  const csrfToken = getMeta('ol-csrfToken')
  const location = useLocation()
  const [repos, setRepos] = useState<Repo[]>([])
  const [selected, setSelected] = useState<Repo | null>(null)
  const [projectName, setProjectName] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/auth/github/repos', { credentials: 'same-origin' })
      .then(res => (res.ok ? res.json() : { repos: [] }))
      .then(data => setRepos(data.repos || []))
      .catch(() => setRepos([]))
  }, [])

  const handleImport = useCallback(async () => {
    if (!selected) return
    setWorking(true)
    setError(null)
    try {
      const res = await fetch('/auth/github/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken ?? '',
        },
        body: JSON.stringify({
          repoOwner: selected.owner.login,
          repoName: selected.name,
          branch: selected.default_branch,
          projectName: projectName || selected.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.message || data?.code || 'import failed')
        return
      }
      location.assign(`/project/${data.projectId}`)
    } catch (err: any) {
      setError(err?.message || 'import failed')
    } finally {
      setWorking(false)
    }
  }, [selected, projectName, csrfToken, location])

  return (
    <OLModal show onHide={onHide}>
      <OLModalHeader>
        <OLModalTitle>{t('select_github_repository')}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {repos.length === 0 ? (
          <p>{t('github_empty_repository_error')}</p>
        ) : (
          <ul className="list-group">
            {repos.map(repo => (
              <li key={`${repo.owner.login}/${repo.name}`}>
                <button
                  type="button"
                  className={`list-group-item ${selected === repo ? 'active' : ''}`}
                  onClick={() => setSelected(repo)}
                >
                  {repo.owner.login}/{repo.name}
                  {repo.empty ? ' (empty)' : ''}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-group">
          <label htmlFor="github-import-project-name">
            {t('project_name', 'Project name')}
          </label>
          <input
            id="github-import-project-name"
            className="form-control"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            placeholder={selected?.name ?? ''}
          />
        </div>
        {error ? <p className="text-danger">{error}</p> : null}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide}>
          {t('cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          disabled={!selected || selected.empty || working}
          onClick={handleImport}
        >
          {t('import', 'Import')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
