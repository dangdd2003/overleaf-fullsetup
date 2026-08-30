import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const USER_ADMIN_LIST_PROJECTION = {
  _id: 1,
  email: 1,
  'emails.email': 1,
  'emails.confirmedAt': 1,
  'emails.createdAt': 1,
  first_name: 1,
  last_name: 1,
  isAdmin: 1,
  signUpDate: 1,
  lastActive: 1,
  lastLoggedIn: 1,
  loginCount: 1,
  holdingAccount: 1,
  suspended: 1,
  role: 1,
  institution: 1,
}

export const DELETED_USER_ADMIN_LIST_PROJECTION = {
  _id: 1,
  deleterData: 1,
  'user._id': 1,
  'user.email': 1,
  'user.first_name': 1,
  'user.last_name': 1,
  'user.signUpDate': 1,
  'user.lastLoggedIn': 1,
  'user.isAdmin': 1,
}

export const USER_DETAIL_PROJECTION = {
  ...USER_ADMIN_LIST_PROJECTION,
  ace: 1,
  features: 1,
}

export async function getActiveUsers({
  search = '',
  page = 1,
  limit = 20,
  sortBy = 'signUpDate',
  sortOrder = 'desc',
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const safePage = Math.max(parseInt(page, 10) || 1, 1)
  const skip = (safePage - 1) * safeLimit

  const match = {}
  const trimmed = typeof search === 'string' ? search.trim().slice(0, 100) : ''
  if (trimmed) {
    const escaped = escapeRegExp(trimmed)
    const regex = new RegExp(escaped, 'i')
    match.$or = [
      { email: regex },
      { first_name: regex },
      { last_name: regex },
      { 'emails.email': regex },
    ]
    if (ObjectId.isValid(trimmed)) {
      match.$or.push({ _id: new ObjectId(trimmed) })
    }
  }

  const allowedSorts = [
    'signUpDate',
    'lastActive',
    'lastLoggedIn',
    'email',
    'first_name',
  ]
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'signUpDate'
  const sortDir = sortOrder === 'asc' ? 1 : -1
  const sortCriteria = { [sortField]: sortDir, _id: -1 }

  const [users, total] = await Promise.all([
    db.users
      .find(match, { projection: USER_ADMIN_LIST_PROJECTION })
      .sort(sortCriteria)
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    db.users.countDocuments(match),
  ])

  const normalizedUsers = users.map(user => ({
    ...user,
    lastActive: user.lastActive || user.lastLoggedIn || null,
  }))

  return {
    users: normalizedUsers,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  }
}

export async function getDeletedUsers({
  search = '',
  page = 1,
  limit = 20,
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const safePage = Math.max(parseInt(page, 10) || 1, 1)
  const skip = (safePage - 1) * safeLimit

  const match = {}
  const trimmed = typeof search === 'string' ? search.trim().slice(0, 100) : ''
  if (trimmed) {
    const escaped = escapeRegExp(trimmed)
    const regex = new RegExp(escaped, 'i')
    match.$or = [
      { 'user.email': regex },
      { 'user.first_name': regex },
      { 'user.last_name': regex },
      { 'user.emails.email': regex },
    ]
    if (ObjectId.isValid(trimmed)) {
      match.$or.push({ 'deleterData.deletedUserId': new ObjectId(trimmed) })
    }
  }

  const [deletedUsers, total] = await Promise.all([
    db.deletedUsers
      .find(match, { projection: DELETED_USER_ADMIN_LIST_PROJECTION })
      .sort({ 'deleterData.deletedAt': -1, _id: -1 })
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    db.deletedUsers.countDocuments(match),
  ])

  const normalizedDeletedUsers = deletedUsers.map(doc => {
    if (doc.user) {
      return {
        ...doc,
        user: {
          ...doc.user,
          lastActive: doc.user.lastActive || doc.user.lastLoggedIn || null,
        },
      }
    }
    return doc
  })

  return {
    deletedUsers: normalizedDeletedUsers,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  }
}

export async function getUserById(userId) {
  if (!ObjectId.isValid(userId)) return null
  const user = await db.users.findOne(
    { _id: new ObjectId(userId) },
    { projection: USER_DETAIL_PROJECTION }
  )
  if (!user) return null
  return {
    ...user,
    lastActive: user.lastActive || user.lastLoggedIn || null,
  }
}
