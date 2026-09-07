/* eslint-disable no-unused-vars */

import Helpers from './lib/helpers.mjs'

const tags = ['server-ce', 'server-pro', 'saas']

const userCredentialsIndexes = [
  {
    unique: true,
    key: {
      user_id: 1,
    },
    name: 'user_id_1',
  },
  {
    key: {
      watchChannelId: 1,
    },
    name: 'watchChannelId_1',
  },
]

const projectStatesIndexes = [
  {
    unique: true,
    key: {
      projectId: 1,
    },
    name: 'projectId_1',
  },
  {
    key: {
      userId: 1,
    },
    name: 'userId_1',
  },
  {
    key: {
      outboundDirtyAt: 1,
    },
    name: 'outboundDirtyAt_1',
  },
]

const migrate = async client => {
  const { db } = client

  await Helpers.addIndexesToCollection(
    db.googleDriveUserCredentials,
    userCredentialsIndexes
  )
  await Helpers.addIndexesToCollection(
    db.googleDriveProjectStates,
    projectStatesIndexes
  )
}

const rollback = async client => {
  const { db } = client

  try {
    await Helpers.dropIndexesFromCollection(
      db.googleDriveUserCredentials,
      userCredentialsIndexes
    )
    await Helpers.dropIndexesFromCollection(
      db.googleDriveProjectStates,
      projectStatesIndexes
    )
  } catch (err) {
    console.error('Something went wrong rolling back the migrations', err)
  }
}

export default {
  tags,
  migrate,
  rollback,
}
