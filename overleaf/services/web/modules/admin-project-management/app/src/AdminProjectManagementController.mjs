import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import logger from '@overleaf/logger'
import { ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import CollaboratorsGetter from '../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs'
import OwnershipTransferHandler from '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

// Accepts either a bare project id or a pasted project URL
// (e.g. https://example.com/project/<id>) and pulls the id out of it.
function extractProjectId(input) {
  if (!input) return null
  const match = String(input).trim().match(/[0-9a-f]{24}/i)
  return match ? match[0] : null
}

export const AdminProjectManagementController = {
  renderLookupPage(req, res) {
    res.render(Path.resolve(__dirname, '../views/project_lookup'), {
      error: req.query.error || null,
    })
  },

  resolveLookup(req, res) {
    const projectId = extractProjectId(req.query.query)
    if (!projectId) {
      return res.redirect('/admin/project?error=not_found')
    }
    res.redirect(`/admin/project/${projectId}`)
  },

  async renderProjectDetail(req, res) {
    const { projectId } = req.params
    if (!ObjectId.isValid(projectId)) {
      return res.redirect('/admin/project?error=not_found')
    }

    const project = await ProjectGetter.promises.getProject(projectId, {
      name: 1,
      owner_ref: 1,
      lastUpdated: 1,
    })
    if (!project) {
      return res.redirect('/admin/project?error=not_found')
    }

    const [owner, memberIds] = await Promise.all([
      UserGetter.promises.getUser(project.owner_ref, { email: 1 }),
      CollaboratorsGetter.promises.getMemberIds(projectId),
    ])

    res.render(Path.resolve(__dirname, '../views/project_detail'), {
      project: {
        id: project._id.toString(),
        name: project.name,
        lastUpdated: project.lastUpdated,
      },
      ownerEmail: owner ? owner.email : '(unknown)',
      // getMemberIds includes the owner, so exclude them from the count
      collaboratorCount: Math.max(0, (memberIds || []).length - 1),
      success: req.query.success || null,
      error: req.query.error || null,
    })
  },

  async transferOwnership(req, res) {
    const { projectId } = req.params
    const newOwnerEmail = String(req.body.newOwnerEmail || '')
      .trim()
      .toLowerCase()

    if (!ObjectId.isValid(projectId)) {
      return res.redirect('/admin/project?error=not_found')
    }
    if (!newOwnerEmail) {
      return res.redirect(`/admin/project/${projectId}?error=missing_email`)
    }

    try {
      const newOwner = await UserGetter.promises.getUserByAnyEmail(
        newOwnerEmail,
        { _id: 1 }
      )
      if (!newOwner) {
        return res.redirect(
          `/admin/project/${projectId}?error=user_not_found`
        )
      }

      const sessionUser = SessionManager.getSessionUser(req.session)

      await OwnershipTransferHandler.promises.transferOwnership(
        projectId,
        newOwner._id,
        {
          allowTransferToNonCollaborators: true,
          sessionUserId: sessionUser && sessionUser._id,
          ipAddress: req.ip,
        }
      )

      return res.redirect(`/admin/project/${projectId}?success=transferred`)
    } catch (err) {
      logger.error(
        { err, projectId },
        'admin project ownership transfer failed'
      )
      return res.redirect(`/admin/project/${projectId}?error=transfer_failed`)
    }
  },
}

export default AdminProjectManagementController
