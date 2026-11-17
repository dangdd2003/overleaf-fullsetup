import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'node:fs/promises'
import Path from 'node:path'
import os from 'node:os'
import Settings from '@overleaf/settings'
import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'
import { AiAssistRunManager } from '../../../app/src/AiAssistRunManager.mjs'
import { AiAssistCheckpointController } from '../../../app/src/AiAssistCheckpointController.mjs'
import checkpointStore from '../../../app/src/AiAssistCheckpointStore.mjs'

describe('AI checkpoint project paths', function () {
  const projectId = '0123456789abcdef01234567'
  const userId = 'abcdef0123456789abcdef01'
  const chatId = 'paths-test'
  const userMessageId = 'u1'
  const canonicalPath = 'sections/new.tex'
  const args = { path: 'sections\\new.tex', content: 'first\nsecond' }
  let testDir, originalSettings, docs, tools, manager, controller, entityHandler

  beforeEach(async function () {
    testDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-checkpoint-paths-'))
    originalSettings = Settings.aiAssist
    Settings.aiAssist = { ...originalSettings, enabled: true, checkpointsDir: testDir }
    docs = {}
    entityHandler = {
      getDocIdByPath: sinon.spy(async (_projectId, path) => docs[path]?._id || null),
      getAllDocs: async () => Object.fromEntries(
        Object.entries(docs).map(([path, doc]) => [`/${path}`, doc])
      ),
    }
    const docUpdater = {
      getDocument: async (_projectId, docId) => Object.values(docs).find(doc => doc._id === docId),
    }
    const editorController = { promises: {
      upsertDocWithPath: async (_projectId, path, lines) => {
        docs[path] = { _id: 'new-doc', lines }
        return docs[path]
      },
      deleteEntity: async (_projectId, docId) => {
        for (const [path, doc] of Object.entries(docs)) {
          if (doc._id === docId) delete docs[path]
        }
      },
      deleteEntityWithPath: async (_projectId, path) => { delete docs[path] },
    } }
    tools = new AiAssistTools({ entityHandler, docUpdater, editorController })
    manager = new AiAssistRunManager({ tools, checkpointStore })
    controller = new AiAssistCheckpointController({
      checkpointStore, entityHandler, docUpdater, editorController,
    })
  })

  afterEach(async function () {
    Settings.aiAssist = originalSettings
    await fs.rm(testDir, { recursive: true, force: true })
  })

  function response() {
    return {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
    }
  }

  function request(body = {}) {
    return {
      params: { Project_id: projectId, chatId },
      session: { user: { _id: userId } },
      body: { userMessageId, ...body },
    }
  }

  async function record() {
    await manager._recordCheckpointBeforeFileChange({
      projectId, userId, chatId, activeUserMessageId: userMessageId,
      toolName: 'create_file', args,
    })
  }

  async function writeLegacyCheckpoint() {
    const dir = Path.join(testDir, `${projectId}-${userId}`, chatId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(Path.join(dir, `${userMessageId}.json`), JSON.stringify({
      userMessageId, createdAt: 1,
      files: { [args.path]: { originalContent: '', docId: null, isNew: true } },
    }))
  }

  for (const legacy of [false, true]) {
    it(`checks and removes create_file sections\\new.tex with ${legacy ? 'an existing stored' : 'a new'} checkpoint`, async function () {
      if (legacy) await writeLegacyCheckpoint()
      else await record()
      const checkpoint = await checkpointStore.getCheckpoint(projectId, userId, chatId, userMessageId)
      expect(checkpoint.files).to.deep.equal({
        [canonicalPath]: { originalContent: '', docId: null, isNew: true },
      })
      const result = await tools.execute('create_file', args, { projectId, userId })
      expect(result.path).to.equal(canonicalPath)
      expect(docs[canonicalPath].lines).to.deep.equal(['first', 'second'])

      const checked = response()
      await controller.check(request(), checked)
      expect(checked.statusCode).to.equal(200)
      expect(checked.body).to.deep.equal({
        canRewind: true, filesChanged: [canonicalPath], insertions: 2, deletions: 0,
      })
      expect(entityHandler.getDocIdByPath.calledWith(projectId, canonicalPath)).to.be.true
      expect(entityHandler.getDocIdByPath.calledWith(projectId, args.path)).to.be.false

      const rewound = response()
      await controller.rewind(request({ restoreCode: true }), rewound)
      expect(rewound.statusCode).to.equal(200)
      expect(rewound.body).to.deep.equal({
        success: true, restoredFiles: [canonicalPath], failedFiles: [],
      })
      expect(docs).to.deep.equal({})
    })
  }

  it('preserves the first legacy snapshot across equivalent paths and later turns', async function () {
    await writeLegacyCheckpoint()
    for (const messageId of [userMessageId, 'u2']) {
      await checkpointStore.saveCheckpoint(projectId, userId, chatId, messageId, {
        files: { ' /./sections//new.tex ': { originalContent: 'later', isNew: false } },
      })
    }
    const checkpoint = await checkpointStore.getRewindCheckpoint(projectId, userId, chatId, userMessageId, {
      userMessageIds: [userMessageId, 'u2'],
    })
    expect(checkpoint.files).to.deep.equal({
      [canonicalPath]: { originalContent: '', docId: null, isNew: true },
    })
    const checked = await checkpointStore.checkRewind(projectId, userId, chatId, userMessageId,
      { [args.path]: args.content }, { checkpoint })
    expect(checked.canRewind).to.be.true
    expect(checked.filesChanged).to.deep.equal([canonicalPath])
  })

  it('records existing content when create_file overwrites a canonical path', async function () {
    docs[canonicalPath] = { _id: 'existing-doc', lines: ['original'] }
    await record()
    const checkpoint = await checkpointStore.getCheckpoint(projectId, userId, chatId, userMessageId)
    expect(checkpoint.files).to.deep.equal({
      [canonicalPath]: { originalContent: 'original', docId: 'existing-doc', isNew: false },
    })
  })

  it('does not record paths rejected by the file tool', async function () {
    for (const path of ['sections\\..\\new.tex', ' /./ ']) {
      await manager._recordCheckpointBeforeFileChange({
        projectId, userId, chatId, activeUserMessageId: userMessageId,
        toolName: 'create_file', args: { ...args, path },
      })
    }
    expect(await checkpointStore.getCheckpoint(projectId, userId, chatId, userMessageId)).to.be.null
  })
})
