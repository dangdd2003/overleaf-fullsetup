import { vi, describe, it, expect, beforeEach } from 'vitest'

const {
  mockProject,
  mockProjectGetter,
  mockCollaboratorsGetter,
  mockCollaboratorsHandler,
  mockEditorRealTimeController,
} = vi.hoisted(() => ({
  mockProject: {
    updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue() })),
  },
  mockProjectGetter: { promises: { getProject: vi.fn() } },
  mockCollaboratorsGetter: {
    promises: { getMemberIdsWithPrivilegeLevels: vi.fn() },
  },
  mockCollaboratorsHandler: {
    promises: { convertTrackChangesToExplicitFormat: vi.fn() },
  },
  mockEditorRealTimeController: { emitToRoom: vi.fn() },
}))

vi.mock('../../../../../app/src/models/Project.mjs', () => ({
  Project: mockProject,
}))
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: mockProjectGetter,
}))
vi.mock(
  '../../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs',
  () => ({ default: mockCollaboratorsGetter })
)
vi.mock(
  '../../../../../app/src/Features/Collaborators/CollaboratorsHandler.mjs',
  () => ({ default: mockCollaboratorsHandler })
)
vi.mock(
  '../../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
  () => ({ default: mockEditorRealTimeController })
)

const { computeTrackChangesState, setTrackChangesState, GUESTS_KEY } =
  await import('../../../app/src/TrackChangesStateHandler.mjs')
const Errors = (
  await import('../../../../../app/src/Features/Errors/Errors.js')
).default

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const EDITOR = 'aaaaaaaaaaaaaaaaaaaaaaa2'
const REVIEWER = 'aaaaaaaaaaaaaaaaaaaaaaa3'
const VIEWER = 'aaaaaaaaaaaaaaaaaaaaaaa4'
const STRANGER = 'aaaaaaaaaaaaaaaaaaaaaaa5'

const members = [
  { id: OWNER, privilegeLevel: 'owner' },
  { id: EDITOR, privilegeLevel: 'readAndWrite' },
  { id: REVIEWER, privilegeLevel: 'review' },
  { id: VIEWER, privilegeLevel: 'readOnly' },
]

function compute(actorId, body, currentState = {}) {
  return computeTrackChangesState({
    currentState,
    members,
    actorId,
    actorIsOwner: actorId === OWNER,
    body,
  })
}

describe('computeTrackChangesState', () => {
  it('lets an editor switch their own Reviewing mode on and off', () => {
    expect(compute(EDITOR, { on_for: { [EDITOR]: true } })).toEqual({
      [EDITOR]: true,
      [REVIEWER]: true,
    })
    expect(
      compute(EDITOR, { on_for: { [EDITOR]: false } }, { [EDITOR]: true })
    ).toEqual({ [REVIEWER]: true })
  })

  it('accepts unchanged entries for other users echoed back by the client', () => {
    const current = { [OWNER]: true }
    expect(
      compute(EDITOR, { on_for: { [OWNER]: true, [EDITOR]: true } }, current)
    ).toEqual({ [OWNER]: true, [EDITOR]: true, [REVIEWER]: true })
  })

  it('forbids an editor from changing another collaborator', () => {
    expect(() => compute(EDITOR, { on_for: { [OWNER]: true } })).toThrow(
      Errors.ForbiddenError
    )
  })

  it('lets the owner change tracking for other collaborators', () => {
    expect(compute(OWNER, { on_for: { [EDITOR]: true } })).toEqual({
      [EDITOR]: true,
      [REVIEWER]: true,
    })
  })

  it('always keeps reviewers tracked', () => {
    expect(
      compute(OWNER, { on_for: { [REVIEWER]: false } }, { [REVIEWER]: true })
    ).toEqual({ [REVIEWER]: true })
    expect(compute(OWNER, { on: false }, { [REVIEWER]: true })).toEqual({
      [REVIEWER]: true,
    })
  })

  it('ignores viewers and non-members', () => {
    expect(
      compute(OWNER, { on_for: { [VIEWER]: true, [STRANGER]: true } })
    ).toEqual({ [REVIEWER]: true })
  })

  it('drops stale entries for users who left the project', () => {
    expect(compute(OWNER, {}, { [STRANGER]: true })).toEqual({
      [REVIEWER]: true,
    })
  })

  it('legacy `on` toggles every writer, owner only', () => {
    expect(compute(OWNER, { on: true })).toEqual({
      [OWNER]: true,
      [EDITOR]: true,
      [REVIEWER]: true,
    })
    expect(() => compute(EDITOR, { on: true })).toThrow(Errors.ForbiddenError)
  })

  it('guest tracking can be set by the owner or an anonymous link editor', () => {
    expect(compute(OWNER, { on_for_guests: true })).toEqual({
      [GUESTS_KEY]: true,
      [REVIEWER]: true,
    })
    expect(compute(null, { on_for_guests: true })).toEqual({
      [GUESTS_KEY]: true,
      [REVIEWER]: true,
    })
    expect(() => compute(EDITOR, { on_for_guests: true })).toThrow(
      Errors.ForbiddenError
    )
  })

  it('keeps the guests flag when other entries change', () => {
    expect(
      compute(EDITOR, { on_for: { [EDITOR]: true } }, { [GUESTS_KEY]: true })
    ).toEqual({ [GUESTS_KEY]: true, [EDITOR]: true, [REVIEWER]: true })
  })
})

describe('setTrackChangesState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectGetter.promises.getProject.mockResolvedValue({
      owner_ref: { toString: () => OWNER },
      track_changes: true,
    })
    mockCollaboratorsHandler.promises.convertTrackChangesToExplicitFormat.mockResolvedValue(
      { [OWNER]: true, [EDITOR]: true }
    )
    mockCollaboratorsGetter.promises.getMemberIdsWithPrivilegeLevels.mockResolvedValue(
      members
    )
  })

  it('persists the explicit state and broadcasts it to the project', async () => {
    const state = await setTrackChangesState('project1', EDITOR, {
      on_for: { [OWNER]: true, [EDITOR]: false },
    })
    expect(state).toEqual({ [OWNER]: true, [REVIEWER]: true })
    expect(mockProject.updateOne).toHaveBeenCalledWith(
      { _id: 'project1' },
      { $set: { track_changes: state } }
    )
    expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
      'project1',
      'toggle-track-changes',
      state
    )
  })

  it('does not persist or broadcast a forbidden change', async () => {
    await expect(
      setTrackChangesState('project1', EDITOR, { on_for: { [OWNER]: false } })
    ).to.be.rejectedWith(Errors.ForbiddenError)
    expect(mockProject.updateOne).not.toHaveBeenCalled()
    expect(mockEditorRealTimeController.emitToRoom).not.toHaveBeenCalled()
  })

  it('throws NotFoundError for a missing project', async () => {
    mockProjectGetter.promises.getProject.mockResolvedValue(null)
    await expect(
      setTrackChangesState('project1', OWNER, { on: true })
    ).to.be.rejectedWith(Errors.NotFoundError)
  })
})
