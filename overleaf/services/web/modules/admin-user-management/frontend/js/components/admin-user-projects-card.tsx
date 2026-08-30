import { useState, useEffect, useCallback, useRef } from 'react'
import OLCard from '@/shared/components/ol/ol-card'
import OLTable from '@/shared/components/ol/ol-table'
import OLButton from '@/shared/components/ol/ol-button'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import Pagination from '@/shared/components/pagination'
import { getJSON } from '@/infrastructure/fetch-json'
import { fromNowDate } from '@/utils/dates'
import TransferProjectModal from './transfer-project-modal'

export interface ProjectItem {
  _id: string
  name: string
  lastUpdated?: string | Date | null
  collaboratorCount: number
  accessLevel: string
}

export interface AdminUserProjectsCardProps {
  userId: string
  userEmail: string
  onError: (err: string) => void
  onSuccess: (msg: string) => void
}

interface ModalConfig {
  show: boolean
  isBulk: boolean
  projectId?: string
  projectName?: string
}

export default function AdminUserProjectsCard({
  userId,
  userEmail,
  onError,
  onSuccess,
}: AdminUserProjectsCardProps) {
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const [modalConfig, setModalConfig] = useState<ModalConfig>({
    show: false,
    isBulk: false,
  })

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setSearchQuery(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(handler)
  }, [searchInput])

  const fetchProjects = useCallback(async () => {
    try {
      const queryParams = new URLSearchParams({
        page: page.toString(),
        limit: '10',
        search: searchQuery,
      })
      const res = await getJSON<{
        projects: ProjectItem[]
        total: number
        totalPages: number
        page: number
      }>(`/admin/users/api/users/${userId}/projects?${queryParams.toString()}`)
      setProjects(res.projects || [])
      setTotal(res.total ?? 0)
      setTotalPages(res.totalPages || 1)
    } catch (err: any) {
      onErrorRef.current?.(err?.message || 'Failed to load user projects')
    } finally {
      setIsLoading(false)
    }
  }, [userId, page, searchQuery])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  function handleTransferSuccess(msg: string) {
    onSuccess(msg)
    fetchProjects()
  }

  function handlePageClick(_e: any, newPage: number) {
    setPage(newPage)
  }

  return (
    <OLCard className="mb-4">
      <div className="card-header bg-transparent py-3 px-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2">
          <h2 className="h4 mb-0">Owned Projects</h2>
          {total > 0 ? (
            <OLBadge bg="info">{total} Projects</OLBadge>
          ) : (
            <OLBadge bg="light" text="dark" className="border">
              0 Projects
            </OLBadge>
          )}
        </div>
        {total > 0 ? (
          <OLButton
            variant="secondary"
            size="sm"
            onClick={() =>
              setModalConfig({
                show: true,
                isBulk: true,
              })
            }
          >
            Transfer All Projects
          </OLButton>
        ) : null}
      </div>

      <div className="card-body">
        <div className="mb-3">
          <OLRow className="g-3 align-items-center">
            <OLCol md={6}>
              <OLFormControl
                type="search"
                placeholder="Search projects by name..."
                value={searchInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSearchInput(e.target.value)
                }
              />
            </OLCol>
          </OLRow>
        </div>

        {isLoading && projects.length === 0 ? (
          <div className="p-4 text-center">
            <OLSpinner />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-muted py-4 text-center">
            {searchQuery
              ? 'No projects matching your search query.'
              : 'This user does not own any projects.'}
          </div>
        ) : (
          <div className="table-responsive">
            <OLTable className="table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Project Name</th>
                  <th>Last Modified</th>
                  <th>Collaborators</th>
                  <th>Access</th>
                  <th className="text-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {projects.map(p => {
                  const isPublic =
                    p.accessLevel === 'public' ||
                    p.accessLevel === 'readAndWrite' ||
                    p.accessLevel === 'readOnly'

                  return (
                    <tr key={p._id}>
                      <td>
                        <a
                          href={`/project/${p._id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="fw-bold text-decoration-none"
                        >
                          {p.name}
                        </a>
                      </td>
                      <td>
                        {p.lastUpdated ? fromNowDate(p.lastUpdated) : '—'}
                      </td>
                      <td>
                        <span className="badge bg-light text-dark border">
                          {p.collaboratorCount}
                        </span>
                      </td>
                      <td>
                        {isPublic ? (
                          <OLBadge bg="info">Public</OLBadge>
                        ) : (
                          <OLBadge bg="light" text="dark" className="border">
                            Private
                          </OLBadge>
                        )}
                      </td>
                      <td className="text-end">
                        <OLButton
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setModalConfig({
                              show: true,
                              isBulk: false,
                              projectId: p._id,
                              projectName: p.name,
                            })
                          }
                        >
                          Transfer
                        </OLButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </OLTable>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="p-3 border-top d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div className="text-muted small">
              Showing page {page} of {totalPages} ({total} total)
            </div>
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              handlePageClick={handlePageClick}
            />
          </div>
        ) : null}
      </div>

      <TransferProjectModal
        show={modalConfig.show}
        onHide={() => setModalConfig(prev => ({ ...prev, show: false }))}
        fromUserId={userId}
        fromUserEmail={userEmail}
        projectId={modalConfig.projectId}
        projectName={modalConfig.projectName}
        isBulk={modalConfig.isBulk}
        totalProjectCount={total}
        onSuccess={handleTransferSuccess}
      />
    </OLCard>
  )
}
