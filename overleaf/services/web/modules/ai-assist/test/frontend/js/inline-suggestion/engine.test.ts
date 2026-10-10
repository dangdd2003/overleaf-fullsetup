import { expect } from 'chai'
import { waitFor } from '@testing-library/react'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  acceptSuggestion,
  inlineSuggestionEngine,
  startSuggestion,
  suggestionField,
} from '../../../../frontend/js/features/ai-assist/inline-suggestion/engine'

function makeView(doc: string, cursor: number) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(cursor),
      extensions: [history(), inlineSuggestionEngine()],
    }),
    parent,
  })
}

function press(view: EditorView, key: string) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor')
}

function pressWith(view: EditorView, key: string, init: KeyboardEventInit) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...init }), 'editor')
}

async function showReady(view: EditorView, pos: number, text: string) {
  const fake = fakeStream([text])
  await startSuggestion(view, { source: 'completion', pos, stream: fake.stream, shape: asIs })
  await revealed(view)
}

/** Waits until the whole suggestion is on screen. */
async function revealed(view: EditorView) {
  await waitFor(() => {
    const value = view.state.field(suggestionField)!
    expect(value.shown).to.equal(value.text.length)
  })
}

function ghostText(view: EditorView) {
  return view.dom.querySelector('.ai-inline-suggestion')?.textContent
}

function type(view: EditorView, at: number, insert: string) {
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: 'input.type',
  })
}

/**
 * A fake relay: yields `replies` in order; before the second it waits for
 * `release()`, or rejects once aborted, like a real request would.
 */
function fakeStream(replies: string[], fail?: Error) {
  let release = () => {}
  const released = new Promise<void>(resolve => (release = resolve))
  let seen: AbortSignal | null = null
  const stream = (signal: AbortSignal) =>
    (async function* () {
      seen = signal
      for (const [index, reply] of replies.entries()) {
        if (index === 1) {
          await Promise.race([
            released,
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error('aborted')))
            ),
          ])
        }
        yield reply
      }
      if (fail) throw fail
    })()
  return { stream, release, signal: () => seen! }
}

const asIs = (raw: string) => ({ text: raw })

describe('inline suggestions: engine', function () {
  afterEach(function () {
    document.body.innerHTML = ''
  })

  it('streams the text in as ghost text and ends with the Tab hint', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' out', ' outperforms it.'])
    fake.release()
    const outcome = await startSuggestion(view, {
      source: 'completion',
      pos: 10,
      stream: fake.stream,
      shape: asIs,
    })
    expect(outcome).to.deep.equal({ status: 'shown', raw: ' outperforms it.' })
    expect(view.state.field(suggestionField)).to.include({
      text: ' outperforms it.',
      status: 'ready',
      pos: 10,
    })
    await waitFor(() => expect(ghostText(view)).to.equal(' outperforms it.⇥ Tab'))
    expect(view.state.doc.toString()).to.equal('Our method')
    view.destroy()
  })

  it('reveals the text word by word, fading each word in', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' outperforms the baseline on every benchmark we tried.'])
    const running = startSuggestion(view, {
      source: 'completion',
      pos: 10,
      stream: fake.stream,
      shape: asIs,
    })
    // Before the first word: the pulse alone
    expect(view.dom.querySelector('.ai-inline-suggestion-pulse')).to.exist
    await running
    const value = view.state.field(suggestionField)!
    expect(value.shown).to.be.below(value.text.length)
    // No Tab hint until all of it shows
    expect(view.dom.querySelector('.ai-inline-suggestion-hint')).to.equal(null)
    await revealed(view)
    const words = view.dom.querySelectorAll('.ai-inline-suggestion-fade')
    expect(words.length).to.be.above(1)
    expect(view.dom.querySelector('.ai-inline-suggestion-pulse')).to.equal(null)
    expect(ghostText(view)).to.equal(
      ' outperforms the baseline on every benchmark we tried.⇥ Tab'
    )
    view.destroy()
  })

  it('does not fade in again what was typed through', async function () {
    const view = makeView('Our method', 10)
    await showReady(view, 10, ' outperforms it.')
    type(view, 10, ' out')
    expect(view.dom.querySelectorAll('.ai-inline-suggestion-fade')).to.have.length(0)
    expect(ghostText(view)).to.equal('performs it.⇥ Tab')
    view.destroy()
  })

  it('Tab inserts the text once, as one undo step, with the cursor after it', async function () {
    const view = makeView('Our method', 10)
    await startSuggestion(view, {
      source: 'completion',
      pos: 10,
      stream: fakeStream([' works.']).stream,
      shape: asIs,
    })
    expect(press(view, 'Tab')).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Our method works.')
    expect(view.state.selection.main.head).to.equal(17)
    expect(view.state.field(suggestionField)).to.equal(null)
    undo(view)
    expect(view.state.doc.toString()).to.equal('Our method')
    view.destroy()
  })

  it('leaves Tab alone when there is no suggestion', function () {
    const view = makeView('Text', 4)
    expect(press(view, 'Tab')).to.equal(false)
    view.destroy()
  })

  it('swallows Tab while the text is still streaming', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' out', ' outperforms it.'])
    const running = startSuggestion(view, { source: 'completion', pos: 10, stream: fake.stream, shape: asIs })
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' out'))
    expect(press(view, 'Tab')).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Our method')
    fake.release()
    expect((await running).status).to.equal('shown')
    view.destroy()
  })

  it('Esc clears and aborts', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' out', ' outperforms it.'])
    const running = startSuggestion(view, { source: 'completion', pos: 10, stream: fake.stream, shape: asIs })
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' out'))
    expect(press(view, 'Escape')).to.equal(true)
    expect(view.state.field(suggestionField)).to.equal(null)
    expect(fake.signal().aborted).to.equal(true)
    expect((await running).status).to.equal('cancelled')
    view.destroy()
  })

  it('clears and aborts when the author types', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' out', ' outperforms it.'])
    const running = startSuggestion(view, { source: 'completion', pos: 10, stream: fake.stream, shape: asIs })
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' out'))
    view.dispatch({ changes: { from: 10, insert: 's' }, selection: { anchor: 11 }, userEvent: 'input.type' })
    expect(view.state.field(suggestionField)).to.equal(null)
    expect(fake.signal().aborted).to.equal(true)
    expect((await running).status).to.equal('cancelled')
    view.destroy()
  })

  it('clears when the cursor moves away', async function () {
    const view = makeView('Our method', 10)
    await startSuggestion(view, { source: 'completion', pos: 10, stream: fakeStream([' works.']).stream, shape: asIs })
    view.dispatch({ selection: { anchor: 3 } })
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it("keeps the suggestion through a collaborator's edit elsewhere", async function () {
    const view = makeView('Our method', 10)
    await startSuggestion(view, { source: 'completion', pos: 10, stream: fakeStream([' works.']).stream, shape: asIs })
    view.dispatch({ changes: { from: 0, insert: 'So ' }, annotations: Transaction.remote.of(true) })
    expect(view.state.field(suggestionField)).to.include({ pos: 13, text: ' works.' })
    view.destroy()
  })

  it("clears on a collaborator's edit at the cursor", async function () {
    const view = makeView('Our method', 10)
    await startSuggestion(view, { source: 'completion', pos: 10, stream: fakeStream([' works.']).stream, shape: asIs })
    view.dispatch({ changes: { from: 10, insert: '!' }, annotations: Transaction.remote.of(true) })
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it('a new suggestion aborts the one before it', async function () {
    const view = makeView('Our method', 10)
    const first = fakeStream([' out', ' outperforms it.'])
    const running = startSuggestion(view, { source: 'completion', pos: 10, stream: first.stream, shape: asIs })
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' out'))
    await startSuggestion(view, { source: 'completion', pos: 10, stream: fakeStream([' wins.']).stream, shape: asIs })
    expect(first.signal().aborted).to.equal(true)
    expect((await running).status).to.equal('cancelled')
    expect(view.state.field(suggestionField)?.text).to.equal(' wins.')
    view.destroy()
  })

  it('clears when the shaped result is empty', async function () {
    const view = makeView('Our method', 10)
    const outcome = await startSuggestion(view, {
      source: 'prompt',
      pos: 10,
      stream: fakeStream(['<answer>no</answer>']).stream,
      shape: () => ({ text: '' }),
    })
    expect(outcome).to.deep.equal({ status: 'empty', raw: '<answer>no</answer>' })
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it('shows the text once shape says stop, and lets the request finish rather than cut it off', async function () {
    const view = makeView('Say', 3)
    const fake = fakeStream([' hi!', ' hi! and more'])
    fake.release()
    const outcome = await startSuggestion(view, {
      source: 'completion',
      pos: 3,
      stream: fake.stream,
      shape: raw => ({ text: raw, stop: raw.endsWith('!') }),
    })
    expect(outcome).to.deep.equal({ status: 'shown', raw: ' hi!' })
    expect(view.state.field(suggestionField)?.text).to.equal(' hi!')
    expect(view.state.field(suggestionField)?.status).to.equal('ready')
    // Accepting it does not cut the request off either
    acceptSuggestion(view)
    expect(fake.signal().aborted).to.equal(false)
    view.destroy()
    expect(fake.signal().aborted).to.equal(false)
  })

  it('rejects and clears when the stream fails', async function () {
    const view = makeView('Our method', 10)
    const error = await startSuggestion(view, {
      source: 'completion',
      pos: 10,
      stream: fakeStream([], new Error('Boom')).stream,
      shape: asIs,
    }).then(
      () => null,
      (e: Error) => e
    )
    expect(error?.message).to.equal('Boom')
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it('calls onFirstText once, when text first shows', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream(['', ' out', ' outperforms it.'])
    fake.release()
    let calls = 0
    await startSuggestion(view, {
      source: 'prompt',
      pos: 10,
      stream: fake.stream,
      shape: asIs,
      onFirstText: () => calls++,
    })
    expect(calls).to.equal(1)
    view.destroy()
  })

  it('typing the next characters of the ghost text shrinks it in place', async function () {
    const view = makeView('Our method', 10)
    await showReady(view, 10, ' outperforms it.')
    const id = view.state.field(suggestionField)!.id
    type(view, 10, ' out')
    expect(view.state.doc.toString()).to.equal('Our method out')
    expect(view.state.field(suggestionField)).to.include({
      id,
      text: 'performs it.',
      typed: ' out',
      pos: 14,
      status: 'ready',
    })
    expect(ghostText(view)).to.equal('performs it.⇥ Tab')
    view.destroy()
  })

  it('typing all of it clears it', async function () {
    const view = makeView('Our method', 10)
    await showReady(view, 10, ' it.')
    type(view, 10, ' it.')
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it('text typed through while streaming stays typed through', async function () {
    const view = makeView('Our method', 10)
    const fake = fakeStream([' out', ' outperforms it.'])
    const running = startSuggestion(view, { source: 'completion', pos: 10, stream: fake.stream, shape: asIs })
    await waitFor(() => expect(view.state.field(suggestionField)?.text).to.equal(' out'))
    type(view, 10, ' o')
    expect(view.state.field(suggestionField)).to.include({ text: 'ut', pos: 12 })
    expect(fake.signal().aborted).to.equal(false)
    fake.release()
    expect((await running).status).to.equal('shown')
    expect(view.state.field(suggestionField)).to.include({ text: 'utperforms it.', pos: 12, status: 'ready' })
    view.destroy()
  })

  it('an auto-closed pair that does not match clears it', async function () {
    const view = makeView('f', 1)
    await showReady(view, 1, '(a, b)')
    type(view, 1, '()')
    expect(view.state.field(suggestionField)).to.equal(null)
    view.destroy()
  })

  it('Ctrl/Cmd+Right accepts one word, or one LaTeX command, at a time', async function () {
    const view = makeView('Our method', 10)
    await showReady(view, 10, ' outperforms \\cite{x}.')
    expect(pressWith(view, 'ArrowRight', { ctrlKey: true })).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Our method outperforms')
    expect(view.state.field(suggestionField)).to.include({ text: ' \\cite{x}.', pos: 22 })
    expect(pressWith(view, 'ArrowRight', { ctrlKey: true })).to.equal(true)
    expect(view.state.doc.toString()).to.equal('Our method outperforms \\cite')
    expect(view.state.field(suggestionField)).to.include({ text: '{x}.' })
    view.destroy()
  })

  it('Ctrl/Cmd+Right is untouched without a ready suggestion', function () {
    const view = makeView('Our method', 10)
    expect(pressWith(view, 'ArrowRight', { ctrlKey: true })).to.equal(false)
    view.destroy()
  })
})
