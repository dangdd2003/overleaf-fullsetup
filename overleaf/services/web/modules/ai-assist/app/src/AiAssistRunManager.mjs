import defaultStore from './AiAssistRunStore.mjs'
import defaultTools from './AiAssistTools.mjs'
import { createProviderClient } from './AiAssistProviders.mjs'

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded in the Overleaf LaTeX editor. You are working inside the user's real project. Treat the project as live.
Be concise. Answer in Markdown. Write LaTeX commands in backticks.
Climb the ladder: read_file, search_project, list_files, edit_file, create_file, compile_project.
Settings & Appearance: Overleaf supports code fonts (monaco, lucida, opendyslexicmono), over 40 editor syntax themes (e.g. dracula, monokai, nord_dark, solarized_dark, overleaf, textmate), font sizes (10-24px), line heights (compact, normal, spacious), keybindings (none, vim, emacs), and overall UI themes (system, light, dark). Use get_project_settings to inspect current settings, list_available_settings to view all allowed options, and configure_appearance_settings / configure_editor_settings to apply changes.`

export function toAgentMessages(transcript) {
  if (!Array.isArray(transcript)) return []
  const messages = []

  transcript.forEach((entry, index) => {
    if (entry.role === 'user') {
      const content = entry.contextText
        ? `${entry.contextText}\n\n${entry.text}`
        : (entry.text || entry.content || '')
      messages.push({ role: 'user', content })
      return
    }

    const isLast = index === transcript.length - 1
    if (isLast && !entry.text && !entry.content && (!entry.toolCalls || entry.toolCalls.length === 0)) return

    if (!entry.toolCalls || entry.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: entry.text || entry.content || '' })
      return
    }

    messages.push({
      role: 'assistant',
      content: entry.text || entry.content || '',
      toolCalls: entry.toolCalls.map(call => ({
        id: call.id,
        name: call.name,
        args: call.args,
      })),
    })

    for (const call of entry.toolCalls) {
      const finished = 'result' in call
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: finished
          ? (typeof call.result === 'string' ? call.result : JSON.stringify(call.result))
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError) : true,
      })
    }
  })

  return messages
}

export class AiAssistRunManager {
  constructor({
    store = defaultStore,
    tools = defaultTools,
    clientFactory = createProviderClient,
  } = {}) {
    this.store = store
    this.tools = tools
    this.clientFactory = clientFactory
    this.activeRuns = new Map()
  }

  async startRun({ runId, projectId, userId, transcript, providerSettings }) {
    const controller = new AbortController()
    const approvalPromiseResolvers = { resolve: null }

    this.activeRuns.set(runId, {
      controller,
      projectId,
      userId,
      approvalResolver: approvalPromiseResolvers,
    })

    await this.store.createRun({ runId, projectId, userId })

    const client = this.clientFactory(providerSettings)
    const messages = toAgentMessages(transcript)

    try {
      let steps = 0
      const maxSteps = 20
      let consecutiveFailures = 0
      const failedCallSignatures = []
      const recentToolNames = []
      let shouldStop = false
      let userDeclinedEdit = false

      while (steps < maxSteps) {
        if (controller.signal.aborted || shouldStop) break

        const calls = []
        let text = ''

        const toolsToUse = userDeclinedEdit
          ? []
          : (this.tools?.getToolSpecs ? this.tools.getToolSpecs() : [])

        for await (const chunk of client.streamChat({
          system: DEFAULT_SYSTEM_PROMPT,
          messages,
          tools: toolsToUse,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          if (chunk.type === 'thinking') {
            await this.store.appendEvent(runId, { type: 'thinking', text: chunk.text })
          } else if (chunk.type === 'text') {
            text += chunk.text
            await this.store.appendEvent(runId, { type: 'text', text: chunk.text })
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk)
          }
        }

        if (controller.signal.aborted) break

        if (calls.length === 0) {
          await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'stop' })
          await this.store.updateStatus(runId, 'done')
          shouldStop = true
          break
        }

        messages.push({ role: 'assistant', content: text, toolCalls: calls })

        for (const call of calls) {
          if (controller.signal.aborted || shouldStop) break
          steps++
          const callId = call.id || `call_${steps}_${runId}`
          call.id = callId

          if (call.name === 'edit_file' && this.tools?.resolveEditTarget) {
            try {
              const target = await this.tools.resolveEditTarget(call.args, { projectId })
              if (target?.path && target.path !== call.args.path) {
                call.args.path = target.path
              }
            } catch {}
          }

          await this.store.appendEvent(runId, {
            type: 'toolCallStarted',
            id: callId,
            name: call.name,
            args: call.args,
          })

          let result = null
          let isError = false

          if (call.name === 'edit_file' || call.name === 'create_file') {
            if (userDeclinedEdit) {
              result = {
                status: 'rejected',
                error: 'The user has already declined previous edits in this turn. Further file modifications are blocked. Acknowledge to the user and explain alternatives or ask how to proceed.',
              }
              shouldStop = true
            } else {
              await this.store.setPendingApproval(runId, { id: call.id, edit: call.args })
              await this.store.appendEvent(runId, {
                type: 'awaitingApproval',
                id: call.id,
                edit: call.args,
              })

              const decision = await new Promise(resolve => {
                approvalPromiseResolvers.resolve = resolve
              })

              if (!decision?.accepted) {
                userDeclinedEdit = true
                const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
                result = {
                  status: 'rejected',
                  message: `The user declined this change${userNote}. Do not attempt any further file modifications or repeat this edit in this turn. Acknowledge to the user that the edit was rejected, address their feedback, and explain alternatives or ask how they would like to proceed.`,
                  note: decision?.note,
                }
              } else {
                try {
                  result = await this.tools.execute(call.name, call.args, { projectId, userId })
                } catch (err) {
                  result = { error: err.message || 'Tool execution failed' }
                  isError = true
                }
              }
            }
          } else {
            try {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }

          await this.store.appendEvent(runId, {
            type: 'toolCallFinished',
            id: call.id,
            name: call.name,
            result,
            isError,
          })

          const isFailed =
            isError ||
            result?.error ||
            result?.status === 'noMatch' ||
            result?.status === 'ambiguous' ||
            result?.status === 'none'

          if (isFailed) {
            consecutiveFailures += 1
            const callSig = `${call.name}:${JSON.stringify(call.args)}`
            failedCallSignatures.push(callSig)
            const identicalFailedCount = failedCallSignatures.filter(s => s === callSig).length

            if (identicalFailedCount >= 2 || consecutiveFailures >= 3) {
              const msg = identicalFailedCount >= 2
                ? `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`
                : `Stopped after ${consecutiveFailures} consecutive failed tool operations. Please check the file contents or provide more specific instructions.`
              await this.store.appendEvent(runId, {
                type: 'error',
                code: identicalFailedCount >= 2 ? 'runawayToolLoop' : 'consecutiveToolFailures',
                message: msg,
              })
              await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'stop' })
              await this.store.updateStatus(runId, 'done')
              shouldStop = true
              break
            }
          } else {
            consecutiveFailures = 0
          }

          // Cycle detection for tool calls (e.g. compile -> get_log -> compile -> get_log)
          recentToolNames.push(call.name)
          if (recentToolNames.length >= 4) {
            const last4 = recentToolNames.slice(-4)
            if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
              await this.store.appendEvent(runId, {
                type: 'error',
                code: 'runawayToolLoop',
                message: `Stopped repeated alternating tool loop between ${last4[0]} and ${last4[1]}.`,
              })
              await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'stop' })
              await this.store.updateStatus(runId, 'done')
              shouldStop = true
              break
            }
          }

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(result),
          })
        }
      }

      if (controller.signal.aborted) {
        await this.store.updateStatus(runId, 'stopped')
      } else if (!shouldStop) {
        await this.store.appendEvent(runId, {
          type: 'turnFinished',
          reason: steps >= maxSteps ? 'budget' : 'stop',
        })
        await this.store.updateStatus(runId, 'done')
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        err.name === 'AbortError' ||
        err.code === 'aborted' ||
        err.code === 'ERR_ABORTED' ||
        err.message?.includes('aborted')
      ) {
        await this.store.updateStatus(runId, 'stopped')
        return
      }
      const code =
        err.code ||
        (err.status === 401 || err.status === 403
          ? 'providerAuth'
          : 'providerError')
      await this.store.appendEvent(runId, {
        type: 'error',
        code,
        status: err.status,
        message: err.message,
      })
      await this.store.updateStatus(runId, 'error', { message: err.message })
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  async stopRun(runId) {
    const active = this.activeRuns.get(runId)
    if (active) {
      active.controller.abort()
      if (active.approvalResolver?.resolve) {
        active.approvalResolver.resolve({ accepted: false })
      }
    }
    await this.store.updateStatus(runId, 'stopped')
    await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
  }

  async approveEdit(runId, decision) {
    const active = this.activeRuns.get(runId)
    if (active?.approvalResolver?.resolve) {
      await this.store.clearPendingApproval(runId, 'running')
      active.approvalResolver.resolve(decision)
    }
  }
}

export default new AiAssistRunManager()
