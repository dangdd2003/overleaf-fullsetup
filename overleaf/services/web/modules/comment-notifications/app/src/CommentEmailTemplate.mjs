import EmailBuilder from '../../../../app/src/Features/Email/EmailBuilder.mjs'
import Settings from '@overleaf/settings'
import _ from 'lodash'

EmailBuilder.templates.commentDigest = EmailBuilder.NoCTAEmailTemplate({
  subject(opts) {
    if (opts.hasMention) {
      return `[${opts.projectName}] You were mentioned in a comment`
    }
    return `[${opts.projectName}] New comment activity`
  },
  greeting(opts) {
    return `Hi ${opts.recipientName || 'there'},`
  },
  message(opts) {
    const lines = []
    const safeProjectName = _.escape(opts.projectName)
    lines.push(
      `There are new comments on your ${Settings.appName} project "<b>${safeProjectName}</b>":`
    )
    lines.push('')
    for (const comment of opts.comments || []) {
      const prefix = comment.isMention ? '📢 ' : ''
      const safeAuthor = _.escape(comment.authorName)
      const safeContent = _.escape(comment.content)
      lines.push(`${prefix}<b>${safeAuthor}</b>: ${safeContent}`)
    }
    lines.push('')
    lines.push(
      `<a href="${opts.projectUrl}">Open project in ${Settings.appName}</a>`
    )
    return lines
  },
})
