import {
  AssistantBlock,
  ToolCallRecord,
  TranscriptEntry,
  blocksForEntry,
} from '../agent-messages'
import { escapeAttribute, neutraliseClosingTags } from './escape'

export type EditDecision = { path: string; startLine: number; accepted: boolean }

export type FixHandoffInput = {
  /** The finished fix run, exactly as the compile-log panel stored it. */
  transcript: TranscriptEntry[]
  /** Approve/reject decisions the panel recorded outside the tool result. */
  decidedEdits: Record<string, EditDecision>
  stoppedForBudget?: boolean
  error?: { code?: string; message?: string } | null
}

const EDIT_TOOLS = new Set(['edit_file', 'create_file'])

/**
 * Tells the model that its constraints just inverted.
 *
 * Without this the run reads as one continuous conversation and the model
 * carries the fix panel's register straight into the chat — refusing to ask
 * the clarifying question the chat exists for, and declining to compile
 * because the earlier harness had taken `compile_project` away. Naming both
 * halves of the change, and what was already spent, is what turns a replayed
 * transcript into a genuine handoff.
 */
const HANDOFF_BLOCK = [
  '<handoff>',
  'The user moved this compile-log entry into the main assistant panel to keep',
  'working on it with you. Everything above is what already happened there.',
  '',
  'That earlier run worked under a restricted harness: no compile_project, no',
  'create_file, a hard step budget, and instructions never to ask a question,',
  'because the compile-log panel has no reply box. None of that applies to you.',
  'You have the full toolset, no step budget, and a user who can answer you.',
  '',
  'Do not repeat the investigation above — the reads and searches it already',
  'made are recorded with their results, and redoing them wastes the budget',
  'the user just handed you. Build on it instead:',
  '',
  '- If a suggested edit is still marked "proposed, not applied" and you agree',
  '  with it, say so briefly and call edit_file to put it up for approval.',
  '- If an edit was rejected, do not simply propose it again. Assume the user',
  '  had a reason, and either ask what it was or offer a different approach.',
  '- If the earlier reasoning looks wrong to you, say which part and why.',
  '- If the earlier run ran out of budget mid-investigation, carry on from',
  '  where it stopped.',
  '- Ask the user a question whenever one would settle the matter faster than',
  '  guessing would.',
  '</handoff>',
].join('\n')

/** How the user ultimately answered an edit the fix run proposed. */
function editStatus(
  call: ToolCallRecord,
  decidedEdits: Record<string, EditDecision>
): string {
  const result = call.result as { status?: string } | undefined
  const decided = decidedEdits[call.id]

  if (result?.status === 'applied' || decided?.accepted === true) return 'applied'
  if (result?.status === 'rejected' || decided?.accepted === false) {
    return 'rejected'
  }
  return 'proposed, not applied'
}

function renderToolCall(
  call: ToolCallRecord,
  decidedEdits: Record<string, EditDecision>
): string {
  const attributes = [` name="${escapeAttribute(call.name)}"`]
  if (EDIT_TOOLS.has(call.name)) {
    attributes.push(` status="${editStatus(call, decidedEdits)}"`)
  }

  const lines = [`<step${attributes.join('')}>`]
  lines.push('<args>', safeJson(call.args), '</args>')

  // Matches toAgentMessages: an unfinished call is reported as such rather
  // than as an empty result, so the model does not read silence as success.
  lines.push(
    '<result>',
    'result' in call ? safeJson(call.result) : 'This tool call did not complete.',
    '</result>'
  )
  lines.push('</step>')

  return lines.join('\n')
}

/** Stringifies tool payloads the way `toAgentMessages` already does. */
function safeJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    text = '"[unserialisable]"'
  }
  return neutraliseClosingTags(text)
}

function renderBlock(
  block: AssistantBlock,
  decidedEdits: Record<string, EditDecision>
): string | null {
  // Thinking is the model's own scratchpad, not context. It is by far the
  // largest part of a run and the least useful to a different model on a
  // different harness, which is the one thing a full transfer still drops.
  if (block.type === 'thinking') return null

  if (block.type === 'text') {
    const text = block.text.trim()
    if (!text) return null
    return ['<said>', neutraliseClosingTags(text), '</said>'].join('\n')
  }

  return renderToolCall(block.call, decidedEdits)
}

/**
 * Renders the whole fix run as provider-facing context for the main chat.
 *
 * The original fix context is carried through byte-for-byte rather than
 * rebuilt: it is already in the stored transcript's first turn, it was already
 * escaped when it was built, and re-reading the source to regenerate it would
 * quietly hand the model a *different* document from the one the run actually
 * reasoned about — which is exactly wrong for the history banner, whose whole
 * purpose is to outlive the file it describes.
 */
export function renderFixHandoff({
  transcript,
  decidedEdits,
  stoppedForBudget,
  error,
}: FixHandoffInput): string {
  const first = transcript.find(entry => entry.role === 'user') as
    | Extract<TranscriptEntry, { role: 'user' }>
    | undefined

  const sections: string[] = []
  if (first?.contextText) sections.push(first.contextText)

  const steps: string[] = []
  for (const entry of transcript) {
    if (entry.role !== 'assistant') continue
    for (const block of blocksForEntry(entry)) {
      const rendered = renderBlock(block, decidedEdits)
      if (rendered) steps.push(rendered)
    }
  }

  if (stoppedForBudget) {
    steps.push(
      '<note>',
      'The run hit its step budget and stopped before it had finished.',
      '</note>'
    )
  }

  if (error?.message) {
    steps.push(
      '<note>',
      `The run failed before finishing: ${neutraliseClosingTags(error.message)}`,
      '</note>'
    )
  }

  sections.push(
    ['<prior-fix-run>', ...steps, '</prior-fix-run>'].join('\n'),
    HANDOFF_BLOCK
  )

  return sections.join('\n')
}
