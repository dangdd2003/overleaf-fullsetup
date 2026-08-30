import { db } from '../../../../app/src/infrastructure/mongodb.mjs'

export class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
    this.statusCode = 400
  }
}

export class ForbiddenError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ForbiddenError'
    this.statusCode = 403
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
    this.statusCode = 404
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConflictError'
    this.statusCode = 409
  }
}

export async function ensureCanModifyAdmin(callerUserId, targetUserId, newIsAdmin) {
  if (String(callerUserId) === String(targetUserId) && !newIsAdmin) {
    throw new BadRequestError('cannot_demote_self')
  }

  if (!newIsAdmin) {
    const activeAdminCount = await db.users.countDocuments({
      isAdmin: true,
      suspended: { $ne: true },
    })
    if (activeAdminCount <= 1) {
      throw new ForbiddenError('cannot_modify_last_admin')
    }
  }
}

export async function ensureCanDeleteUser(callerUserId, targetUser) {
  if (!targetUser) {
    throw new NotFoundError('user_not_found')
  }

  if (String(callerUserId) === String(targetUser._id)) {
    throw new BadRequestError('cannot_delete_self')
  }

  if (targetUser.isAdmin) {
    const activeAdminCount = await db.users.countDocuments({
      isAdmin: true,
      suspended: { $ne: true },
    })
    if (activeAdminCount <= 1) {
      throw new ForbiddenError('cannot_modify_last_admin')
    }
  }
}
