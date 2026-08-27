# Native Git Integration for Overleaf Community Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement native Git integration in Overleaf Community Edition (Server CE) enabling users to clone, edit, push, and pull Overleaf projects using standard Git clients over HTTP with Personal Access Token authentication.

**Architecture:** A native feature module in `services/web` (`Features/GitBridge`) provides token management (`POST/GET/DELETE /user/personal-access-tokens`), OAuth token verification (`GET /oauth/token/info`), and Snapshot APIs (`/api/v0/docs/...`). `services/git-bridge` (Java/JGit) runs as a service connected to Web, and frontend UI components in the Editor rail and Account Settings provide seamless token generation and Git cloning.

**Tech Stack:** Node.js (ESM), Express, MongoDB/Mongoose, React 18, TypeScript, Java 8/17 (writelatex-git-bridge), Docker Compose, Nginx, Cypress.

**Spec:** `docs/superpowers/specs/2026-08-24-git-integration-design.md`

## Global Constraints
- Token format: `olp_<32_random_alphanumeric_or_hex_chars>`.
- Token prefix displayed in UI: first 8 characters (e.g. `olp_1234`).
- Passwords for Git HTTP authentication must be Personal Access Tokens; username is always `git`.
- Snapshot API endpoints must be mounted at `/api/v0/docs` to match `git-bridge` `SnapshotAPIRequest` contract.
- Read-only collaborators must be permitted to `git clone` and `git pull`, but forbidden (HTTP 403) from `git push`.
- Push conflict detection: Return HTTP 409 Conflict if incoming `latestVerId` does not match the project's current version.

---

### Task 1: Personal Access Token (PAT) Data Model & Manager

**Files:**
- Create: `services/web/app/src/models/PersonalAccessToken.mjs`
- Create: `services/web/app/src/Features/GitBridge/PersonalAccessTokenManager.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenManagerTests.mjs`

**Interfaces:**
- Produces:
  - `PersonalAccessTokenManager.createToken(userId, name): Promise<{ token: string, tokenPrefix: string, record: object }>`
  - `PersonalAccessTokenManager.validateToken(rawToken): Promise<{ user_id: string, email: string, scope: string[] } | null>`
  - `PersonalAccessTokenManager.listTokens(userId): Promise<Array<{ _id: string, name: string, tokenPrefix: string, createdAt: Date, lastUsedAt: Date }>>`
  - `PersonalAccessTokenManager.revokeToken(userId, tokenId): Promise<boolean>`

- [ ] **Step 1: Write the failing unit tests for PersonalAccessTokenManager**

```javascript
// services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenManagerTests.mjs
import { expect } from 'chai'
import sinon from 'sinon'
import PersonalAccessTokenManager from '../../../../app/src/Features/GitBridge/PersonalAccessTokenManager.mjs'
import { PersonalAccessToken } from '../../../../app/src/models/PersonalAccessToken.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import mongoose from 'mongoose'

describe('PersonalAccessTokenManager', function () {
  const userId = new mongoose.Types.ObjectId()
  const userEmail = 'test@example.com'

  beforeEach(function () {
    sinon.stub(User, 'findById').resolves({
      _id: userId,
      email: userEmail
    })
  })

  afterEach(function () {
    sinon.restore()
  })

  it('creates a token with olp_ prefix, hashes it, and stores it in MongoDB', async function () {
    const createStub = sinon.stub(PersonalAccessToken, 'create').resolves({
      _id: new mongoose.Types.ObjectId(),
      user_id: userId,
      name: 'My Laptop',
      tokenPrefix: 'olp_1234',
      tokenHash: 'abc123hash',
      scopes: ['git_bridge'],
      createdAt: new Date()
    })

    const result = await PersonalAccessTokenManager.createToken(userId, 'My Laptop')
    expect(result.token).to.match(/^olp_[a-zA-Z0-9]{32}$/)
    expect(result.tokenPrefix).to.equal(result.token.slice(0, 8))
    expect(createStub.calledOnce).to.be.true
  })

  it('validates a correct token and updates lastUsedAt', async function () {
    const rawToken = 'olp_12345678901234567890123456789012'
    const findOneAndUpdateStub = sinon.stub(PersonalAccessToken, 'findOneAndUpdate').resolves({
      _id: new mongoose.Types.ObjectId(),
      user_id: userId,
      scopes: ['git_bridge']
    })

    const validation = await PersonalAccessTokenManager.validateToken(rawToken)
    expect(validation).to.deep.equal({
      user_id: userId.toString(),
      email: userEmail,
      scope: ['git_bridge']
    })
    expect(findOneAndUpdateStub.calledOnce).to.be.true
  })

  it('returns null for an invalid or missing token', async function () {
    sinon.stub(PersonalAccessToken, 'findOneAndUpdate').resolves(null)
    const validation = await PersonalAccessTokenManager.validateToken('olp_invalid')
    expect(validation).to.be.null
  })

  it('revokes a token owned by the user', async function () {
    const tokenId = new mongoose.Types.ObjectId()
    const deleteStub = sinon.stub(PersonalAccessToken, 'deleteOne').resolves({ deletedCount: 1 })

    const success = await PersonalAccessTokenManager.revokeToken(userId, tokenId)
    expect(success).to.be.true
    expect(deleteStub.calledWith({ _id: tokenId, user_id: userId })).to.be.true
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenManagerTests.mjs`
Expected: FAIL with module/model not found.

- [ ] **Step 3: Implement PersonalAccessToken model and PersonalAccessTokenManager**

```javascript
// services/web/app/src/models/PersonalAccessToken.mjs
import mongoose from '../infrastructure/Mongoose.mjs'
const { Schema } = mongoose

export const PersonalAccessTokenSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: 'Git Token' },
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenPrefix: { type: String, required: true },
    scopes: { type: [String], default: ['git_bridge'] },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date }
  },
  { collection: 'personalAccessTokens' }
)

export const PersonalAccessToken = mongoose.model(
  'PersonalAccessToken',
  PersonalAccessTokenSchema
)
```

```javascript
// services/web/app/src/Features/GitBridge/PersonalAccessTokenManager.mjs
import crypto from 'node:crypto'
import { PersonalAccessToken } from '../../models/PersonalAccessToken.mjs'
import { User } from '../../models/User.mjs'

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

const PersonalAccessTokenManager = {
  async createToken(userId, name = 'Git Token') {
    const rawSecret = crypto.randomBytes(16).toString('hex')
    const token = `olp_${rawSecret}`
    const tokenPrefix = token.slice(0, 8)
    const tokenHash = hashToken(token)

    const record = await PersonalAccessToken.create({
      user_id: userId,
      name,
      tokenPrefix,
      tokenHash,
      scopes: ['git_bridge'],
      createdAt: new Date()
    })

    return {
      token,
      tokenPrefix,
      record
    }
  },

  async validateToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null
    const tokenHash = hashToken(rawToken.trim())

    const record = await PersonalAccessToken.findOneAndUpdate(
      { tokenHash },
      { $set: { lastUsedAt: new Date() } },
      { new: true }
    )
    if (!record) return null

    const user = await User.findById(record.user_id, { email: 1 })
    if (!user) return null

    return {
      user_id: user._id.toString(),
      email: user.email,
      scope: record.scopes || ['git_bridge']
    }
  },

  async listTokens(userId) {
    return PersonalAccessToken.find(
      { user_id: userId },
      { _id: 1, name: 1, tokenPrefix: 1, createdAt: 1, lastUsedAt: 1, expiresAt: 1 }
    ).sort({ createdAt: -1 })
  },

  async revokeToken(userId, tokenId) {
    const result = await PersonalAccessToken.deleteOne({
      _id: tokenId,
      user_id: userId
    })
    return result.deletedCount > 0
  }
}

export default PersonalAccessTokenManager
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenManagerTests.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/models/PersonalAccessToken.mjs services/web/app/src/Features/GitBridge/PersonalAccessTokenManager.mjs services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenManagerTests.mjs
git commit -m "feat(git-bridge): add PersonalAccessToken model and manager"
```

---

### Task 2: Personal Access Token Web Controllers & Routes

**Files:**
- Create: `services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs`
- Create: `services/web/app/src/Features/GitBridge/Oauth2TokenInfoController.mjs`
- Modify: `services/web/app/src/router.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenControllerTests.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/Oauth2TokenInfoControllerTests.mjs`

**Interfaces:**
- Consumes: `PersonalAccessTokenManager` from Task 1
- Produces:
  - `POST /user/personal-access-tokens` -> `{ token, tokenPrefix, name, createdAt }`
  - `GET /user/personal-access-tokens` -> `[{ _id, name, tokenPrefix, createdAt, lastUsedAt }]`
  - `DELETE /user/personal-access-tokens/:tokenId` -> HTTP 204
  - `GET /oauth/token/info` -> `{ user_id, email, scope }`

- [ ] **Step 1: Write the failing unit tests for Controllers**

```javascript
// services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenControllerTests.mjs
import { expect } from 'chai'
import sinon from 'sinon'
import PersonalAccessTokenController from '../../../../app/src/Features/GitBridge/PersonalAccessTokenController.mjs'
import PersonalAccessTokenManager from '../../../../app/src/Features/GitBridge/PersonalAccessTokenManager.mjs'

describe('PersonalAccessTokenController', function () {
  let req, res

  beforeEach(function () {
    req = {
      session: { user: { _id: 'user-123' } },
      body: {},
      params: {}
    }
    res = {
      json: sinon.stub(),
      sendStatus: sinon.stub(),
      status: sinon.stub().returnsThis()
    }
  })

  afterEach(function () {
    sinon.restore()
  })

  it('creates token and returns raw secret', async function () {
    req.body.name = 'Work Laptop'
    sinon.stub(PersonalAccessTokenManager, 'createToken').resolves({
      token: 'olp_secret123',
      tokenPrefix: 'olp_secr',
      record: { _id: 'rec-1', name: 'Work Laptop', createdAt: new Date() }
    })

    await PersonalAccessTokenController.createToken(req, res)
    expect(res.json.calledWith({
      token: 'olp_secret123',
      tokenPrefix: 'olp_secr',
      name: 'Work Laptop',
      createdAt: sinon.match.any
    })).to.be.true
  })

  it('lists tokens for user', async function () {
    sinon.stub(PersonalAccessTokenManager, 'listTokens').resolves([
      { _id: 'rec-1', name: 'Work Laptop', tokenPrefix: 'olp_secr' }
    ])

    await PersonalAccessTokenController.listTokens(req, res)
    expect(res.json.calledWith([
      { _id: 'rec-1', name: 'Work Laptop', tokenPrefix: 'olp_secr' }
    ])).to.be.true
  })

  it('revokes token', async function () {
    req.params.tokenId = 'rec-1'
    sinon.stub(PersonalAccessTokenManager, 'revokeToken').resolves(true)

    await PersonalAccessTokenController.revokeToken(req, res)
    expect(res.sendStatus.calledWith(204)).to.be.true
  })
})
```

```javascript
// services/web/test/unit/src/Features/GitBridge/Oauth2TokenInfoControllerTests.mjs
import { expect } from 'chai'
import sinon from 'sinon'
import Oauth2TokenInfoController from '../../../../app/src/Features/GitBridge/Oauth2TokenInfoController.mjs'
import PersonalAccessTokenManager from '../../../../app/src/Features/GitBridge/PersonalAccessTokenManager.mjs'

describe('Oauth2TokenInfoController', function () {
  let req, res

  beforeEach(function () {
    req = { headers: {} }
    res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis()
    }
  })

  afterEach(function () {
    sinon.restore()
  })

  it('authenticates Bearer token header and returns token info', async function () {
    req.headers.authorization = 'Bearer olp_validtoken123'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      user_id: 'user-123',
      email: 'test@example.com',
      scope: ['git_bridge']
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.json.calledWith({
      user_id: 'user-123',
      email: 'test@example.com',
      scope: ['git_bridge']
    })).to.be.true
  })

  it('authenticates Basic git:<token> header and returns token info', async function () {
    req.headers.authorization = `Basic ${Buffer.from('git:olp_validtoken123').toString('base64')}`
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      user_id: 'user-123',
      email: 'test@example.com',
      scope: ['git_bridge']
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.json.calledWith({
      user_id: 'user-123',
      email: 'test@example.com',
      scope: ['git_bridge']
    })).to.be.true
  })

  it('returns 401 when token is invalid', async function () {
    req.headers.authorization = 'Bearer olp_badtoken'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves(null)

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.status.calledWith(401)).to.be.true
    expect(res.json.calledWith({
      error: 'invalid_token',
      error_description: 'The access token provided is invalid or expired.'
    })).to.be.true
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenControllerTests.mjs services/web/test/unit/src/Features/GitBridge/Oauth2TokenInfoControllerTests.mjs`
Expected: FAIL

- [ ] **Step 3: Implement Controllers & Mount Routes in router.mjs**

```javascript
// services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs
import PersonalAccessTokenManager from './PersonalAccessTokenManager.mjs'

const PersonalAccessTokenController = {
  async createToken(req, res) {
    const userId = req.session?.user?._id
    const { name } = req.body
    const result = await PersonalAccessTokenManager.createToken(userId, name)
    return res.json({
      token: result.token,
      tokenPrefix: result.tokenPrefix,
      name: result.record.name,
      createdAt: result.record.createdAt
    })
  },

  async listTokens(req, res) {
    const userId = req.session?.user?._id
    const tokens = await PersonalAccessTokenManager.listTokens(userId)
    return res.json(tokens)
  },

  async revokeToken(req, res) {
    const userId = req.session?.user?._id
    const { tokenId } = req.params
    await PersonalAccessTokenManager.revokeToken(userId, tokenId)
    return res.sendStatus(204)
  }
}

export default PersonalAccessTokenController
```

```javascript
// services/web/app/src/Features/GitBridge/Oauth2TokenInfoController.mjs
import PersonalAccessTokenManager from './PersonalAccessTokenManager.mjs'

function extractToken(req) {
  const authHeader = req.headers?.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, ...passParts] = decoded.split(':')
    return passParts.join(':')
  }
  return null
}

const Oauth2TokenInfoController = {
  async getTokenInfo(req, res) {
    const rawToken = extractToken(req)
    if (!rawToken) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Authorization header is missing or malformed.'
      })
    }

    const tokenInfo = await PersonalAccessTokenManager.validateToken(rawToken)
    if (!tokenInfo) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'The access token provided is invalid or expired.'
      })
    }

    return res.json(tokenInfo)
  }
}

export default Oauth2TokenInfoController
```

Modify `services/web/app/src/router.mjs` to mount:
- `app.post('/user/personal-access-tokens', AuthenticationController.requireLogin(), PersonalAccessTokenController.createToken)`
- `app.get('/user/personal-access-tokens', AuthenticationController.requireLogin(), PersonalAccessTokenController.listTokens)`
- `app.delete('/user/personal-access-tokens/:tokenId', AuthenticationController.requireLogin(), PersonalAccessTokenController.revokeToken)`
- `app.get('/oauth/token/info', Oauth2TokenInfoController.getTokenInfo)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenControllerTests.mjs services/web/test/unit/src/Features/GitBridge/Oauth2TokenInfoControllerTests.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs services/web/app/src/Features/GitBridge/Oauth2TokenInfoController.mjs services/web/app/src/router.mjs services/web/test/unit/src/Features/GitBridge/
git commit -m "feat(git-bridge): add token management and oauth token info endpoints"
```

---

### Task 3: Snapshot API Adapter - Read Endpoints (`/api/v0/docs/...`)

**Files:**
- Create: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs`
- Create: `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs`
- Modify: `services/web/app/src/router.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManagerTests.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/GitBridgeApiControllerTests.mjs`

**Interfaces:**
- Consumes: `ProjectGetter`, `ProjectEntityHandler`, `DocstoreManager`, `AuthorizationMiddleware`, `PersonalAccessTokenManager`
- Produces:
  - `GET /api/v0/docs/:projectId` -> `{ latestVerId, latestVerAt, latestVerBy }`
  - `GET /api/v0/docs/:projectId/saved_vers` -> `[{ versionId, comment, user, createdAt }]`
  - `GET /api/v0/docs/:projectId/snapshots/:versionId` -> `{ srcs: [[content, path]], atts: [[url, path]] }`

- [ ] **Step 1: Write failing unit tests for Snapshot Read operations**

```javascript
// services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManagerTests.mjs
import { expect } from 'chai'
import sinon from 'sinon'
import GitBridgeSnapshotManager from '../../../../app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'

describe('GitBridgeSnapshotManager - Read', function () {
  const projectId = '60f1b4a9e1b2c3d4e5f6g7h8'

  afterEach(function () {
    sinon.restore()
  })

  it('gets doc metadata with latest version', async function () {
    sinon.stub(ProjectGetter, 'getProjectWithOnlyFolders').resolves({
      _id: projectId,
      version: 5,
      lastUpdatedAt: new Date('2026-08-24T10:00:00Z'),
      owner_ref: { email: 'owner@example.com', first_name: 'Jane', last_name: 'Doe' }
    })

    const meta = await GitBridgeSnapshotManager.getDoc(projectId)
    expect(meta.latestVerId).to.equal(5)
    expect(meta.latestVerBy.email).to.equal('owner@example.com')
  })

  it('retrieves snapshot files (srcs and atts)', async function () {
    sinon.stub(ProjectGetter, 'getProjectWithOnlyFolders').resolves({
      _id: projectId,
      version: 5,
      rootFolder: [
        {
          _id: 'root-folder-id',
          name: 'root',
          docs: [{ _id: 'doc-1', name: 'main.tex' }],
          fileRefs: [{ _id: 'file-1', name: 'logo.png' }],
          folders: []
        }
      ]
    })
    sinon.stub(DocstoreManager, 'getDoc').resolves(['\\documentclass{article}', '\\begin{document}'])

    const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(projectId, 5)
    expect(snapshot.srcs).to.deep.equal([
      ['\\documentclass{article}\n\\begin{document}', 'main.tex']
    ])
    expect(snapshot.atts[0][1]).to.equal('logo.png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManagerTests.mjs`
Expected: FAIL

- [ ] **Step 3: Implement GitBridgeSnapshotManager and GitBridgeApiController**

```javascript
// services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs
import ProjectGetter from '../Project/ProjectGetter.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import Settings from '@overleaf/settings'

const GitBridgeSnapshotManager = {
  async getDoc(projectId) {
    const project = await ProjectGetter.getProjectWithOnlyFolders(projectId)
    if (!project) return null

    return {
      latestVerId: project.version || 0,
      latestVerAt: project.lastUpdatedAt || new Date(),
      latestVerBy: {
        email: project.owner_ref?.email || 'git@overleaf.com',
        name: `${project.owner_ref?.first_name || ''} ${project.owner_ref?.last_name || ''}`.trim() || 'Overleaf User'
      }
    }
  },

  async getSavedVers(projectId) {
    const docInfo = await this.getDoc(projectId)
    if (!docInfo) return []
    return [
      {
        versionId: docInfo.latestVerId,
        comment: 'Current version',
        user: docInfo.latestVerBy,
        createdAt: docInfo.latestVerAt
      }
    ]
  },

  async getSnapshotForVersion(projectId, versionId) {
    const project = await ProjectGetter.getProjectWithOnlyFolders(projectId)
    if (!project) return null

    const srcs = []
    const atts = []
    const baseUrl = Settings.siteUrl || `http://localhost:${Settings.port || 3000}`

    async function traverseFolder(folder, currentPath = '') {
      for (const doc of folder.docs || []) {
        const filePath = currentPath ? `${currentPath}/${doc.name}` : doc.name
        const lines = await DocstoreManager.getDoc(projectId, doc._id.toString())
        const content = Array.isArray(lines) ? lines.join('\n') : (lines || '')
        srcs.push([content, filePath])
      }
      for (const file of folder.fileRefs || []) {
        const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
        const fileUrl = `${baseUrl}/project/${projectId}/file/${file._id}/download`
        atts.push([fileUrl, filePath])
      }
      for (const subFolder of folder.folders || []) {
        const subPath = currentPath ? `${currentPath}/${subFolder.name}` : subFolder.name
        await traverseFolder(subFolder, subPath)
      }
    }

    if (project.rootFolder && project.rootFolder[0]) {
      await traverseFolder(project.rootFolder[0])
    }

    return { srcs, atts }
  }
}

export default GitBridgeSnapshotManager
```

```javascript
// services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs
import GitBridgeSnapshotManager from './GitBridgeSnapshotManager.mjs'

const GitBridgeApiController = {
  async getDoc(req, res) {
    const { projectId } = req.params
    const doc = await GitBridgeSnapshotManager.getDoc(projectId)
    if (!doc) {
      return res.status(404).json({ code: 'invalidProject', message: 'Project not found' })
    }
    return res.json(doc)
  },

  async getSavedVers(req, res) {
    const { projectId } = req.params
    const savedVers = await GitBridgeSnapshotManager.getSavedVers(projectId)
    return res.json(savedVers)
  },

  async getSnapshot(req, res) {
    const { projectId, versionId } = req.params
    const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(projectId, parseInt(versionId, 10))
    if (!snapshot) {
      return res.status(404).json({ code: 'invalidProject', message: 'Snapshot not found' })
    }
    return res.json(snapshot)
  }
}

export default GitBridgeApiController
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManagerTests.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs services/web/test/unit/src/Features/GitBridge/
git commit -m "feat(git-bridge): implement snapshot read endpoints"
```

---

### Task 4: Snapshot API Adapter - Push Ingestion & Postback

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs`
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs`
- Test: `services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotPushTests.mjs`

**Interfaces:**
- Consumes: `ProjectEntityHandler`, `DocumentUpdaterHandler`, `fetch`
- Produces:
  - `POST /api/v0/docs/:projectId/snapshots` -> HTTP 202 `{ status: 202, code: "accepted" }`
  - Asynchronous HTTP POST to `postbackUrl` with `{ code: "upToDate", latestVerId }`

- [ ] **Step 1: Write failing unit test for Push Ingestion**

```javascript
// services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotPushTests.mjs
import { expect } from 'chai'
import sinon from 'sinon'
import GitBridgeSnapshotManager from '../../../../app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'

describe('GitBridgeSnapshotManager - Push', function () {
  const projectId = '60f1b4a9e1b2c3d4e5f6g7h8'

  afterEach(function () {
    sinon.restore()
  })

  it('rejects push with outOfDate if version does not match latest', async function () {
    sinon.stub(ProjectGetter, 'getProjectWithOnlyFolders').resolves({
      _id: projectId,
      version: 10
    })

    const result = await GitBridgeSnapshotManager.validatePushVersion(projectId, 8)
    expect(result.valid).to.be.false
    expect(result.code).to.equal('outOfDate')
  })

  it('accepts push if version matches latest', async function () {
    sinon.stub(ProjectGetter, 'getProjectWithOnlyFolders').resolves({
      _id: projectId,
      version: 10
    })

    const result = await GitBridgeSnapshotManager.validatePushVersion(projectId, 10)
    expect(result.valid).to.be.true
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotPushTests.mjs`
Expected: FAIL

- [ ] **Step 3: Implement Push Ingestion and Postback logic**

Add `validatePushVersion`, `processPush`, and postback invocation to `GitBridgeSnapshotManager.mjs` and `GitBridgeApiController.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotPushTests.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/ services/web/test/unit/src/Features/GitBridge/
git commit -m "feat(git-bridge): implement push snapshot ingestion and postback"
```

---

### Task 5: Frontend UI - "Clone with Git" Modal in Editor Rail

**Files:**
- Create: `services/web/frontend/js/features/ide-react/components/modals/git-bridge-modal.tsx`
- Modify: `services/web/frontend/js/features/integrations-panel/integrations-panel.tsx`
- Modify: `services/web/frontend/js/features/ide-react/components/rail/rail-modals.tsx`
- Test: `services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx`

**Interfaces:**
- Produces: `<GitBridgeModal show={boolean} />` with `data-testid="git-bridge-modal"` matching `server-ce/test/git-bridge.spec.ts` contract.

- [ ] **Step 1: Write frontend component test for GitBridgeModal**

```tsx
// services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { expect } from 'chai'
import GitBridgeModal from '../../../../frontend/js/features/ide-react/components/modals/git-bridge-modal'

describe('GitBridgeModal', () => {
  it('renders clone command and generate token button', () => {
    render(<GitBridgeModal show={true} projectId="12345" />)
    expect(screen.getByTestId('git-bridge-modal')).to.exist
    expect(screen.getByLabelText(/Git clone project command/i)).to.exist
    expect(screen.getByRole('button', { name: /Generate token/i })).to.exist
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:frontend services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement GitBridgeModal and wire into IntegrationsPanel and rail-modals**

Implement `GitBridgeModal.tsx` displaying:
- Clone URL: `git clone https://<window.location.host>/git/<projectId>`
- Copy command button
- Token generation button calling `POST /user/personal-access-tokens`
- Direct link to `/user/settings`

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:frontend services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/frontend/js/features/ services/web/test/frontend/features/ide-react/
git commit -m "feat(frontend): add Clone with Git modal to Editor Integrations rail"
```

---

### Task 6: Frontend UI - Token Management in User Account Settings

**Files:**
- Create: `services/web/frontend/js/features/settings/components/linking/git-tokens-widget.tsx`
- Modify: `services/web/frontend/js/features/settings/components/linking-section.tsx`
- Test: `services/web/test/frontend/features/settings/git-tokens-widget.test.tsx`

**Interfaces:**
- Produces: `<GitTokensWidget />` in `/user/settings`

- [ ] **Step 1: Write frontend test for GitTokensWidget**

```tsx
// services/web/test/frontend/features/settings/git-tokens-widget.test.tsx
import { render, screen } from '@testing-library/react'
import { expect } from 'chai'
import GitTokensWidget from '../../../../frontend/js/features/settings/components/linking/git-tokens-widget'

describe('GitTokensWidget', () => {
  it('renders Git integration heading and Generate token button', () => {
    render(<GitTokensWidget />)
    expect(screen.getByRole('heading', { name: /Git integration/i })).to.exist
    expect(screen.getByRole('button', { name: /Generate token|Add another token/i })).to.exist
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:frontend services/web/test/frontend/features/settings/git-tokens-widget.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement GitTokensWidget and embed into LinkingSection**

Implement `git-tokens-widget.tsx` fetching `/user/personal-access-tokens`, rendering table of active tokens with creation date, delete/revoke button, and "Generate token" dialog.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:frontend services/web/test/frontend/features/settings/git-tokens-widget.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/frontend/js/features/settings/ services/web/test/frontend/features/settings/
git commit -m "feat(frontend): add Git token management widget to Account Settings"
```

---

### Task 7: Docker Compose, Nginx Reverse Proxy & Service Configuration

**Files:**
- Modify: `server-ce/.dockerignore`
- Modify: `server-ce/services.js`
- Modify: `server-ce/test/docker-compose.yml`
- Modify: `services/web/config/settings.defaults.js`

- [ ] **Step 1: Update .dockerignore and services.js to support git-bridge**
- [ ] **Step 2: Configure default environment variables in settings.defaults.js**
- [ ] **Step 3: Commit**

```bash
git add server-ce/ services/web/config/
git commit -m "feat(docker): configure git-bridge service orchestration"
```

---

### Task 8: End-to-End Acceptance Test Verification

**Files:**
- Run: `server-ce/test/git-bridge.spec.ts`

- [ ] **Step 1: Execute Cypress E2E test suite**
- [ ] **Step 2: Verify all tests in git-bridge.spec.ts pass (clone, token creation, push, pull, collaborator permissions)**
- [ ] **Step 3: Commit any final polish**

```bash
git commit -m "test: verify git-bridge end-to-end acceptance tests pass"
```
