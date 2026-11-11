import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { ObjectId } from 'mongodb'
import { AiAssistRunController } from '../../../app/src/AiAssistRunController.mjs'

const owner = 'a'.repeat(24)

// Every run endpoint, and whether it is also served by a legacy route that
// names no project
const ENDPOINTS = [
  { name: 'streamRun', legacy: true },
  { name: 'stopRun', legacy: true },
  { name: 'approve', legacy: true },
  { name: 'compileResult', legacy: false },
  { name: 'queueMessage', legacy: false },
  { name: 'unqueueMessage', legacy: false },
  { name: 'sendQueuedNow', legacy: false },
  { name: 'setMode', legacy: false },
]

const ROUTES = ENDPOINTS.flatMap(({ name, legacy }) => [
  { endpoint: name, legacy: false },
  ...(legacy ? [{ endpoint: name, legacy: true }] : []),
])

const DENIED = [
  ['another collaborator', 'b'.repeat(24), owner],
  ['missing session', undefined, owner],
  ['non-ObjectId session', 'user-1', 'user-1'],
  ['missing owner', owner, undefined],
  ['null owner and session', null, null],
  ['empty owner and session', '', ''],
]

describe('AiAssistRunController initiating-user ownership', function () {
  for (const { endpoint, legacy } of ROUTES) {
    const route = `${legacy ? 'legacy' : 'project'} ${endpoint}`

    for (const [name, userId, runUserId] of DENIED) {
      it(`denies ${name} for ${route}`, async function () {
        const ctx = setup({ userId, runUserId, legacy })
        await ctx.controller[endpoint](ctx.req, ctx.res)
        expectDenied(ctx)
        // The ownership gate answers before any project check
        expect(ctx.authorization.canUserReadProject.called).to.equal(false)
        expect(ctx.authorization.canUserWriteProjectContent.called).to.equal(
          false
        )
      })
    }

    for (const [kind, userId] of [
      ['ObjectId', new ObjectId(owner)],
      ['string', owner],
    ]) {
      it(`allows the initiating ${kind} session for ${route}`, async function () {
        const { controller, req, res } = setup({
          userId,
          runUserId: owner,
          legacy,
        })
        await controller[endpoint](req, res)
        expect(res.status.called).to.equal(false)
        if (endpoint === 'streamRun') expect(res.write.called).to.equal(true)
        else expect(res.json.calledWith({ ok: true })).to.equal(true)
      })
    }

    if (legacy) {
      it(`denies the owner who lost project access for ${route}`, async function () {
        const ctx = setup({
          userId: owner,
          runUserId: owner,
          legacy,
          projectAccess: false,
        })
        await ctx.controller[endpoint](ctx.req, ctx.res)
        expectDenied(ctx)
        const checked =
          ctx.authorization.canUserReadProject.calledWith(owner, 'p1') ||
          ctx.authorization.canUserWriteProjectContent.calledWith(owner, 'p1')
        expect(checked).to.equal(true)
      })
    }
  }

  function expectDenied({ res, manager, subscriber, store }) {
    expect(res.status.calledWith(403)).to.equal(true)
    expect(res.json.firstCall.args[0]).to.have.property('error')
    for (const method of Object.values(manager)) {
      expect(method.called).to.equal(false)
    }
    expect(subscriber.subscribe.called).to.equal(false)
    expect(store.getEvents.called).to.equal(false)
    expect(store.addWatcher.called).to.equal(false)
    expect(res.write.called).to.equal(false)
  }

  function setup({ userId, runUserId, legacy, projectAccess = true }) {
    const manager = Object.fromEntries(
      [
        'stopRun',
        'approveEdit',
        'submitCompileResult',
        'queueMessage',
        'unqueueMessage',
        'sendQueuedNow',
        'setMode',
      ].map(name => [name, sinon.stub().resolves(true)])
    )
    const store = {
      getRun: sinon
        .stub()
        .resolves({ projectId: 'p1', userId: runUserId, status: 'running' }),
      getEvents: sinon.stub().resolves([]),
      addWatcher: sinon.stub().resolves(),
      removeWatcher: sinon.stub().resolves(),
    }
    const subscriber = { subscribe: sinon.stub().resolves(() => {}) }
    const authorization = {
      canUserReadProject: sinon.stub().resolves(projectAccess),
      canUserWriteProjectContent: sinon.stub().resolves(projectAccess),
    }
    const controller = new AiAssistRunController({
      manager,
      store,
      subscriber,
      authorization,
    })
    const req = {
      params: {
        ...(legacy ? {} : { Project_id: 'p1' }),
        runId: 'run-1',
        messageId: 'q1',
      },
      session: userId === undefined ? undefined : { user: { _id: userId } },
      query: {},
      body: { id: 'q1', text: 'hello', mode: 'manual', accepted: true },
      on: sinon.stub(),
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      setHeader: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    }
    return { controller, req, res, manager, subscriber, store, authorization }
  }
})
