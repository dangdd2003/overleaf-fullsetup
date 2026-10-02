import { vi, describe, it, expect, beforeEach } from 'vitest'

const {
  mockSessionManager,
  mockDocumentUpdaterHandler,
  mockDocstoreManager,
  mockEditorRealTimeController,
  mockUserGetter,
  mockStateHandler,
} = vi.hoisted(() => ({
  mockSessionManager: { getLoggedInUserId: vi.fn() },
  mockDocumentUpdaterHandler: {
    promises: {
      acceptChanges: vi.fn(),
      flushProjectToMongo: vi.fn(),
    },
  },
  mockDocstoreManager: {
    promises: {
      getAllRanges: vi.fn(),
      getTrackedChangesUserIds: vi.fn(),
    },
  },
  mockEditorRealTimeController: { emitToRoom: vi.fn() },
  mockUserGetter: { promises: { getUsers: vi.fn() } },
  mockStateHandler: { setTrackChangesState: vi.fn() },
}))

vi.mock(
  '../../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({ default: mockSessionManager })
)
vi.mock(
  '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
  () => ({ default: mockDocumentUpdaterHandler })
)
vi.mock('../../../../../app/src/Features/Docstore/DocstoreManager.mjs', () => ({
  default: mockDocstoreManager,
}))
vi.mock(
  '../../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
  () => ({ default: mockEditorRealTimeController })
)
vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: mockUserGetter,
}))
vi.mock('../../../app/src/TrackChangesStateHandler.mjs', () => ({
  default: mockStateHandler,
}))

const TrackChangesController = (
  await import('../../../app/src/TrackChangesController.mjs')
).default

const PROJECT = '5f0000000000000000000001'
const DOC = '5f0000000000000000000002'
const USER = '5f0000000000000000000003'

function reqRes(params, body = {}) {
  const req = { params, body, query: {}, session: {} }
  const res = { json: vi.fn(), sendStatus: vi.fn() }
  return { req, res, next: vi.fn() }
}

describe('TrackChangesController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionManager.getLoggedInUserId.mockReturnValue(USER)
  })

  describe('setTrackChangesState', () => {
    it('delegates the validated body to the state handler', async () => {
      const body = { on_for: { [USER]: true } }
      const { req, res } = reqRes({ project_id: PROJECT }, body)
      await TrackChangesController.setTrackChangesState(req, res)
      expect(mockStateHandler.setTrackChangesState).toHaveBeenCalledWith(
        PROJECT,
        USER,
        body
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })

    it('rejects on_for keys that are not user ids', async () => {
      const { req, res, next } = reqRes(
        { project_id: PROJECT },
        { on_for: { __guests__: true } }
      )
      await TrackChangesController.setTrackChangesState(req, res, next)
      expect(mockStateHandler.setTrackChangesState).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })
  })

  describe('acceptChanges', () => {
    it('accepts changes in document-updater and broadcasts them', async () => {
      const { req, res } = reqRes(
        { project_id: PROJECT, doc_id: DOC },
        { change_ids: ['c1', 'c2'] }
      )
      await TrackChangesController.acceptChanges(req, res)
      expect(
        mockDocumentUpdaterHandler.promises.acceptChanges
      ).toHaveBeenCalledWith(PROJECT, DOC, ['c1', 'c2'], USER)
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        PROJECT,
        'accept-changes',
        DOC,
        ['c1', 'c2']
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })

    it('rejects an empty change list', async () => {
      const { req, res, next } = reqRes(
        { project_id: PROJECT, doc_id: DOC },
        { change_ids: [] }
      )
      await TrackChangesController.acceptChanges(req, res, next)
      expect(
        mockDocumentUpdaterHandler.promises.acceptChanges
      ).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalled()
    })
  })

  describe('getAllRanges', () => {
    it('flushes, then returns ranges keyed by doc id', async () => {
      mockDocstoreManager.promises.getAllRanges.mockResolvedValue([
        { _id: DOC, ranges: { changes: [{ id: 'c1' }] } },
        { _id: 'other' },
      ])
      const { req, res } = reqRes({ project_id: PROJECT })
      await TrackChangesController.getAllRanges(req, res)
      expect(
        mockDocumentUpdaterHandler.promises.flushProjectToMongo
      ).toHaveBeenCalledWith(PROJECT)
      expect(res.json).toHaveBeenCalledWith([
        { id: DOC, ranges: { changes: [{ id: 'c1' }] } },
        { id: 'other', ranges: {} },
      ])
    })
  })

  describe('getAllChangesUsers', () => {
    it('returns personal info for valid change authors only', async () => {
      mockDocstoreManager.promises.getTrackedChangesUserIds.mockResolvedValue([
        USER,
        'not-an-id',
        null,
      ])
      mockUserGetter.promises.getUsers.mockResolvedValue([
        {
          _id: { toString: () => USER },
          email: 'a@b.c',
          first_name: 'A',
          last_name: 'B',
        },
      ])
      const { req, res } = reqRes({ project_id: PROJECT })
      await TrackChangesController.getAllChangesUsers(req, res)

      const [query, projection] = mockUserGetter.promises.getUsers.mock.calls[0]
      expect(query._id.$in.map(String)).toEqual([USER])
      expect(projection).toEqual({ email: 1, first_name: 1, last_name: 1 })
      expect(res.json).toHaveBeenCalledWith([
        { id: USER, email: 'a@b.c', first_name: 'A', last_name: 'B' },
      ])
    })
  })
})
