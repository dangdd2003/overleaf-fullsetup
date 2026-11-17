import mongodb from 'mongodb-legacy'
import * as mongo from '../../../../app/src/infrastructure/mongodb.mjs'

const { db } = mongo
const ObjectId = Object.keys(mongo).includes('ObjectId')
  ? mongo.ObjectId
  : mongodb.ObjectId
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i

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
    let targetIsActiveAdmin = true
    if (typeof db.users?.findOne === 'function') {
      const targetQuery =
        OBJECT_ID_RE.test(String(targetUserId)) && ObjectId
          ? { _id: new ObjectId(String(targetUserId)) }
          : { _id: targetUserId }
      const targetUser = await db.users.findOne(targetQuery, {
        projection: { isAdmin: 1, suspended: 1 },
      })
      if (targetUser && (!targetUser.isAdmin || targetUser.suspended)) {
        targetIsActiveAdmin = false
      }
    }
    if (targetIsActiveAdmin) {
      const activeAdminCount = await db.users.countDocuments({
        isAdmin: true,
        suspended: { $ne: true },
      })
      if (activeAdminCount <= 1) {
        throw new ForbiddenError('cannot_modify_last_admin')
      }
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

  if (targetUser.isAdmin && !targetUser.suspended) {
    const activeAdminCount = await db.users.countDocuments({
      isAdmin: true,
      suspended: { $ne: true },
    })
    if (activeAdminCount <= 1) {
      throw new ForbiddenError('cannot_modify_last_admin')
    }
  }
}
