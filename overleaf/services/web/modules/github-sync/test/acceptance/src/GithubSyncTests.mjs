import { expect } from 'chai'
import { db, ObjectId } from '../../../../../app/src/infrastructure/mongodb.mjs'
import UserHelper from '../../../../../test/acceptance/src/helpers/User.mjs'

const User = UserHelper.promises

describe('GithubSync', function () {
  beforeEach(async function () {
    this.owner = new User()
    await this.owner.login()
    this.projectId = await this.owner.createProject('github sync test project')
    this.project = { _id: this.projectId }
  })

  describe('status endpoint', function () {
    it('returns linked=false for an unlinked project', async function () {
      const { response, body } = await this.owner.doRequest('GET', {
        url: `/project/${this.projectId}/github/status`,
        json: true,
      })
      response.statusCode.should.equal(200)
      body.linked.should.equal(false)
    })

    it('returns 404 pull for an unlinked project', async function () {
      const { response, body } = await this.owner.doRequest('POST', {
        url: `/project/${this.projectId}/github/pull`,
        json: true,
      })
      response.statusCode.should.equal(404)
      body.code.should.equal('notLinked')
    })
  })

  describe('projectModified hook', function () {
    it('marks outgoing when a linked project is modified', async function () {
      await db.githubSyncProjectStates.insertOne({
        project_id: new ObjectId(this.projectId),
        user_id: new ObjectId(this.owner._id),
        repo: { owner: 'octo', name: 'paper' },
        repoDefaultBranch: 'main',
        lastSyncedCommitSha: 'abc',
        syncState: 'idle',
        outgoing: false,
      })
      const Modules = (
        await import('../../../../../app/src/infrastructure/Modules.mjs')
      ).default
      await Modules.promises.hooks.fire('projectModified', {
        projectId: this.projectId,
        timestamp: Date.now(),
      })
      const doc = await db.githubSyncProjectStates.findOne({
        project_id: new ObjectId(this.projectId),
      })
      expect(doc).to.exist
      doc.outgoing.should.equal(true)
    })
  })
})
