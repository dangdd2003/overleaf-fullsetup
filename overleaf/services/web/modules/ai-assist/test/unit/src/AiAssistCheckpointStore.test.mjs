import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import fs from 'node:fs/promises'
import Path from 'node:path'
import os from 'node:os'
import Settings from '@overleaf/settings'
import store, {
  saveCheckpoint,
  getCheckpoint,
  checkRewind,
  deleteChatCheckpoints,
  getRewindCheckpoint,
  copyCheckpoints,
  baseDir,
  isValidChatId,
  isValidUserMessageId,
} from '../../../app/src/AiAssistCheckpointStore.mjs'

describe('AiAssistCheckpointStore', function () {
  const PROJECT = '0123456789abcdef01234567'
  const USER = 'abcdef0123456789abcdef01'
  const CHAT_ID = 'chat_123'
  const MSG_ID_1 = 'u_msg_001'
  const MSG_ID_2 = 'u_msg_002'

  let testDir
  let origCheckpointsDir
  let origChatHistoryDir

  beforeEach(async function () {
    testDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'checkpoints-test-'))
    origCheckpointsDir = Settings.aiAssist?.checkpointsDir
    origChatHistoryDir = Settings.aiAssist?.chatHistoryDir
    Settings.aiAssist = {
      ...(Settings.aiAssist || {}),
      checkpointsDir: testDir,
    }
  })

  afterEach(async function () {
    Settings.aiAssist.checkpointsDir = origCheckpointsDir
    Settings.aiAssist.chatHistoryDir = origChatHistoryDir
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('baseDir and ID validation', function () {
    it('uses configured checkpointsDir', function () {
      expect(baseDir()).to.equal(testDir)
    })

    it('falls back to chatHistoryDir/checkpoints when checkpointsDir is not set', function () {
      delete Settings.aiAssist.checkpointsDir
      Settings.aiAssist.chatHistoryDir = '/custom/data/ai-assist'
      expect(baseDir()).to.equal('/custom/data/ai-assist/checkpoints')
    })

    it('validates chat IDs', function () {
      expect(isValidChatId('valid-chat_123')).to.be.true
      expect(isValidChatId('../escape')).to.be.false
      expect(isValidChatId('')).to.be.false
      expect(isValidChatId(null)).to.be.false
    })

    it('validates user message IDs', function () {
      expect(isValidUserMessageId('u0')).to.be.true
      expect(isValidUserMessageId('msg-123_abc.def')).to.be.true
      expect(isValidUserMessageId('../bad')).to.be.false
      expect(isValidUserMessageId('foo/bar')).to.be.false
      expect(isValidUserMessageId('')).to.be.false
      expect(isValidUserMessageId(null)).to.be.false
    })

    it('rejects invalid project or user IDs in saveCheckpoint', async function () {
      try {
        await saveCheckpoint('invalid-proj', USER, CHAT_ID, MSG_ID_1, {
          files: {},
        })
        expect.fail('should reject')
      } catch (err) {
        expect(err.message).to.equal('invalid project or user id')
      }

      try {
        await saveCheckpoint(PROJECT, 'invalid-user', CHAT_ID, MSG_ID_1, {
          files: {},
        })
        expect.fail('should reject')
      } catch (err) {
        expect(err.message).to.equal('invalid project or user id')
      }
    })

    it('rejects invalid chat id or user message id', async function () {
      try {
        await saveCheckpoint(PROJECT, USER, '../bad', MSG_ID_1, { files: {} })
        expect.fail('should reject')
      } catch (err) {
        expect(err.message).to.equal('invalid chat id')
      }

      try {
        await saveCheckpoint(PROJECT, USER, CHAT_ID, '../bad', { files: {} })
        expect.fail('should reject')
      } catch (err) {
        expect(err.message).to.equal('invalid user message id')
      }
    })
  })

  describe('saveCheckpoint and getCheckpoint', function () {
    it('saves and retrieves a checkpoint', async function () {
      const saved = await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'main.tex': {
            originalContent: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}',
            docId: 'doc_1',
            isNew: false,
          },
        },
      })

      expect(saved.projectId).to.equal(PROJECT)
      expect(saved.userId).to.equal(USER)
      expect(saved.chatId).to.equal(CHAT_ID)
      expect(saved.userMessageId).to.equal(MSG_ID_1)
      expect(saved.files['main.tex'].originalContent).to.include('Hello')
      expect(saved.files['main.tex'].docId).to.equal('doc_1')
      expect(saved.files['main.tex'].isNew).to.be.false

      const retrieved = await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      expect(retrieved).to.deep.equal(saved)
    })

    it('returns null for non-existent checkpoint', async function () {
      const res = await getCheckpoint(PROJECT, USER, CHAT_ID, 'nonexistent')
      expect(res).to.be.null
    })

    it('preserves the FIRST originalContent when saving multiple edits in the same turn', async function () {
      // First edit in this turn: original content is version 1
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'main.tex': {
            originalContent: 'version 1',
            docId: 'doc_1',
            isNew: false,
          },
        },
      })

      // Second edit in the same turn: incoming content is version 2
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'main.tex': {
            originalContent: 'version 2',
            docId: 'doc_1',
            isNew: false,
          },
          'other.tex': {
            originalContent: 'other original',
            docId: 'doc_2',
            isNew: false,
          },
        },
      })

      const checkpoint = await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      // Must preserve FIRST originalContent ('version 1') for main.tex
      expect(checkpoint.files['main.tex'].originalContent).to.equal('version 1')
      // And include other.tex which was not in the first edit
      expect(checkpoint.files['other.tex'].originalContent).to.equal('other original')
    })

    it('preserves createdAt and updates updatedAt on subsequent saves', async function () {
      const first = await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A', docId: '1' } },
      })
      await new Promise(r => setTimeout(r, 10))
      const second = await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'b.tex': { originalContent: 'B', docId: '2' } },
      })

      expect(second.createdAt).to.equal(first.createdAt)
      expect(second.updatedAt).to.be.at.least(first.updatedAt)
    })
  })

  describe('checkpoint order', function () {
    it('returns null when no checkpoint exists', async function () {
      expect(await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)).to.be.null
    })

    it('rewinds over the checkpoints from M onward, in chronological order', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B' } },
      })

      const fromFirst = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      expect(Object.keys(fromFirst.files).sort()).to.deep.equal(['a.tex', 'b.tex'])
      const fromSecond = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2)
      expect(Object.keys(fromSecond.files)).to.deep.equal(['b.tex'])
    })
  })

  describe('checkRewind', function () {
    it('returns canRewind: false when checkpoint does not exist', async function () {
      const res = await checkRewind(PROJECT, USER, CHAT_ID, 'nonexistent', {
        'main.tex': 'some text',
      })
      expect(res).to.deep.equal({
        canRewind: false,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      })
    })

    it('returns canRewind: false when current files match original content', async function () {
      const content = 'line 1\nline 2\nline 3'
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'main.tex': {
            originalContent: content,
            docId: '1',
            isNew: false,
          },
        },
      })

      const res = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        'main.tex': content,
      })
      expect(res.canRewind).to.be.false
      expect(res.filesChanged).to.deep.equal([])
      expect(res.insertions).to.equal(0)
      expect(res.deletions).to.equal(0)
    })

    it('detects insertions and deletions on modified files', async function () {
      const original = 'line 1\nline 2\nline 3'
      // Current has line 2 changed and 2 extra lines added
      const current = 'line 1\nmodified line 2\nline 3\nline 4\nline 5'

      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'main.tex': {
            originalContent: original,
            docId: '1',
            isNew: false,
          },
        },
      })

      const res = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        'main.tex': current,
      })

      expect(res.canRewind).to.be.true
      expect(res.filesChanged).to.deep.equal(['main.tex'])
      expect(res.insertions).to.be.greaterThan(0)
      expect(res.deletions).to.be.greaterThan(0)
    })

    it('handles files with leading slash path normalization and object format', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          '/src/main.tex': {
            originalContent: 'original text',
            docId: '1',
            isNew: false,
          },
        },
      })

      const res = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        'src/main.tex': { lines: ['new text 1', 'new text 2'] },
      })

      expect(res.canRewind).to.be.true
      expect(res.filesChanged).to.deep.equal(['/src/main.tex'])
    })

    it('handles isNew files correctly', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'newfile.tex': {
            originalContent: '',
            docId: 'new_1',
            isNew: true,
          },
        },
      })

      // When new file currently exists:
      const res1 = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        'newfile.tex': 'new line 1\nnew line 2',
      })
      expect(res1.canRewind).to.be.true
      expect(res1.filesChanged).to.deep.equal(['newfile.tex'])
      expect(res1.insertions).to.equal(2)
      expect(res1.deletions).to.equal(0)

      // When new file was already deleted (not in currentFiles):
      const res2 = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {})
      expect(res2.canRewind).to.be.false
      expect(res2.filesChanged).to.deep.equal([])
      expect(res2.insertions).to.equal(0)
      expect(res2.deletions).to.equal(0)
    })

    it('handles deleted files (existed in checkpoint, but missing in currentFiles)', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: {
          'deleted.tex': {
            originalContent: 'line 1\nline 2',
            docId: 'd1',
            isNew: false,
          },
        },
      })

      const res = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {})
      expect(res.canRewind).to.be.true
      expect(res.filesChanged).to.deep.equal(['deleted.tex'])
      expect(res.deletions).to.equal(2)
    })
  })

  describe('deleteChatCheckpoints', function () {
    it('deletes all checkpoints for a chat', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A' } },
      })
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B' } },
      })

      expect(await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2)).to.not.be.null

      await deleteChatCheckpoints(PROJECT, USER, CHAT_ID)

      expect(await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2)).to.be.null
      expect(await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)).to.be.null
    })

    it('does not throw when deleting checkpoints for non-existent chat', async function () {
      await deleteChatCheckpoints(PROJECT, USER, 'non-existent-chat')
    })
  })

  describe('getRewindCheckpoint', function () {
    const MSG_ID_3 = 'u_msg_003'

    it('merges the checkpoints of M and every later message, first-seen wins', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0', docId: 'a' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: {
          'a.tex': { originalContent: 'A1', docId: 'a' },
          'b.tex': { originalContent: 'B1', docId: 'b' },
        },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_3, {
        files: { 'c.tex': { originalContent: 'C2', docId: 'c' } },
      })

      const res = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      expect(res.userMessageId).to.equal(MSG_ID_1)
      expect(Object.keys(res.files).sort()).to.deep.equal(['a.tex', 'b.tex', 'c.tex'])
      expect(res.files['a.tex'].originalContent).to.equal('A0')
      expect(res.files['b.tex'].originalContent).to.equal('B1')
      expect(res.files['c.tex'].originalContent).to.equal('C2')
    })

    it('ignores checkpoints of messages before M (createdAt fallback)', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B1' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_3, {
        files: { 'c.tex': { originalContent: 'C2' } },
      })

      const res = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2)
      expect(Object.keys(res.files).sort()).to.deep.equal(['b.tex', 'c.tex'])
    })

    it('returns null when M has no checkpoint and there is nothing to fall back to', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B1' } },
      })

      // M1 has no checkpoint, so only M1 itself is considered
      expect(await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)).to.be.null
    })

    it('uses the explicit userMessageIds order and includes ids older by createdAt', async function () {
      // M2 is saved first, so it is older than M1 by createdAt
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: {
          'a.tex': { originalContent: 'from M2' },
          'b.tex': { originalContent: 'B' },
        },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'from M1' } },
      })

      const forward = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        userMessageIds: [MSG_ID_1, MSG_ID_2],
      })
      expect(forward.files['a.tex'].originalContent).to.equal('from M1')
      expect(forward.files['b.tex'].originalContent).to.equal('B')

      const reversed = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        userMessageIds: [MSG_ID_2, MSG_ID_1],
      })
      expect(reversed.files['a.tex'].originalContent).to.equal('from M2')
    })

    it('prepends M when the explicit list does not start with it and drops invalid ids', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'from M1' } },
      })
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B' } },
      })

      const res = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        userMessageIds: ['../bad', MSG_ID_2],
      })
      expect(Object.keys(res.files).sort()).to.deep.equal(['a.tex', 'b.tex'])
      expect(res.files['a.tex'].originalContent).to.equal('from M1')
    })

    it('dedupes file paths across leading-slash spellings and keeps the first spelling', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { '/main.tex': { originalContent: 'first' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'main.tex': { originalContent: 'second' } },
      })

      const res = await getRewindCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      expect(Object.keys(res.files)).to.deep.equal(['/main.tex'])
      expect(res.files['/main.tex'].originalContent).to.equal('first')
    })
  })

  describe('checkRewind with cumulative checkpoints', function () {
    it('compares current files against the merged state before M', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B0' } },
      })

      const res = await checkRewind(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        'a.tex': 'A0',
        'b.tex': 'B1',
      })
      expect(res.canRewind).to.be.true
      expect(res.filesChanged).to.deep.equal(['b.tex'])
    })

    it('limits the merge to the userMessageIds option when given', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B0' } },
      })

      const res = await checkRewind(
        PROJECT,
        USER,
        CHAT_ID,
        MSG_ID_1,
        { 'a.tex': 'A0', 'b.tex': 'B1' },
        { userMessageIds: [MSG_ID_1] }
      )
      expect(res.canRewind).to.be.false
      expect(res.filesChanged).to.deep.equal([])
    })
  })

  describe('copyCheckpoints', function () {
    const FORK_CHAT = 'fork_chat'

    it('copies existing checkpoints into the target chat with chatId rewritten', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0', docId: 'a' } },
      })
      await new Promise(r => setTimeout(r, 15))
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_2, {
        files: { 'b.tex': { originalContent: 'B0', docId: 'b' } },
      })

      const copied = await copyCheckpoints(PROJECT, USER, CHAT_ID, FORK_CHAT, [
        MSG_ID_1,
        'u_missing',
        MSG_ID_2,
      ])
      expect(copied).to.deep.equal([MSG_ID_1, MSG_ID_2])

      const copy = await getCheckpoint(PROJECT, USER, FORK_CHAT, MSG_ID_1)
      expect(copy.chatId).to.equal(FORK_CHAT)
      expect(copy.files['a.tex'].originalContent).to.equal('A0')
      expect(await getCheckpoint(PROJECT, USER, FORK_CHAT, MSG_ID_2)).to.not.be.null

      const source = await getCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1)
      expect(source.chatId).to.equal(CHAT_ID)

      // Rewind works inside the fork
      const rewind = await getRewindCheckpoint(PROJECT, USER, FORK_CHAT, MSG_ID_1)
      expect(Object.keys(rewind.files).sort()).to.deep.equal(['a.tex', 'b.tex'])
    })

    it('returns [] for the same chat, invalid ids or non-array userMessageIds', async function () {
      await saveCheckpoint(PROJECT, USER, CHAT_ID, MSG_ID_1, {
        files: { 'a.tex': { originalContent: 'A0' } },
      })

      expect(await copyCheckpoints(PROJECT, USER, CHAT_ID, CHAT_ID, [MSG_ID_1])).to.deep.equal([])
      expect(await copyCheckpoints(PROJECT, USER, CHAT_ID, '../bad', [MSG_ID_1])).to.deep.equal([])
      expect(await copyCheckpoints(PROJECT, USER, CHAT_ID, FORK_CHAT, 'nope')).to.deep.equal([])
      expect(await getCheckpoint(PROJECT, USER, FORK_CHAT, MSG_ID_1)).to.be.null
    })
  })
})
