/* eslint-disable no-unused-vars */

import Helpers from './lib/helpers.mjs'

const tags = ['server-ce', 'server-pro', 'saas']

const indexes = [
  {
    // At most one queued or running import sync per user. `active` is only
    // present while the job is unfinished, so finished jobs don't collide.
    unique: true,
    key: {
      userId: 1,
    },
    name: 'userId_1_active',
    partialFilterExpression: {
      active: true,
    },
  },
  {
    key: {
      userId: 1,
      createdAt: -1,
    },
    name: 'userId_1_createdAt_-1',
  },
  {
    key: {
      active: 1,
      leaseExpiresAt: 1,
    },
    name: 'active_1_leaseExpiresAt_1',
  },
]

const migrate = async client => {
  const { db } = client
  await Helpers.addIndexesToCollection(db.googleDriveImportJobs, indexes)
}

const rollback = async client => {
  const { db } = client
  try {
    await Helpers.dropIndexesFromCollection(db.googleDriveImportJobs, indexes)
  } catch (err) {
    console.error('Something went wrong rolling back the migrations', err)
  }
}

export default {
  tags,
  migrate,
  rollback,
}
