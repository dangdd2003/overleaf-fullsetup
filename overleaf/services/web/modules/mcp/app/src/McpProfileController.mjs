import { createHash } from 'node:crypto'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import McpErrors from './McpErrors.mjs'

const McpProfileController = {
  async getProfile(req, res) {
    const user = await UserGetter.promises.getUser(req.mcpUserId, {
      first_name: 1,
      last_name: 1,
      email: 1,
    })
    if (!user) return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
    const id = `olp_profile_${createHash('sha256').update(user._id.toString()).digest('hex')}`
    return res.json({
      id,
      ...(name ? { name } : {}),
      ...(user.email ? { email: user.email } : {}),
    })
  },
}

export default McpProfileController
