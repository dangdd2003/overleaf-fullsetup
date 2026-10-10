import { useContext } from 'react'
import {
  OLModal,
  OLModalBody,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import { SplitTestContext } from '@/shared/context/split-test-context'
import { plainMasked } from '../../language-suggestions/masked-text'
import {
  blockKey,
  unblockSuggestion,
} from '../../language-suggestions/preferences'
import type { UnitSuggestions } from '../../language-suggestions/state'
import { SuggestionCard } from './suggestion-card'
import { useLanguageSuggestionsPreferences } from './use-language-suggestions-preferences'

const PREVIEW_TEXT =
  'Ultimately, geography helps us understand global issues, from climate change to resource management and urban plans, fostering a holistic view of our interconnected planet.'
const PREVIEW_AT = PREVIEW_TEXT.indexOf('plans,')

/** The example card of the empty list (upstream image): blurred, inert. */
export const PREVIEW_UNIT: UnitSuggestions = {
  hash: 'preview',
  from: 0,
  to: PREVIEW_TEXT.length,
  masked: plainMasked(PREVIEW_TEXT),
  edits: [
    { from: PREVIEW_AT, to: PREVIEW_AT + 6, original: 'plans,', insert: 'planning,' },
  ],
}

const noop = () => {}

function useThemedModals(): boolean {
  const context = useContext(SplitTestContext)
  return context?.splitTestVariants?.['themed-modals'] === 'enabled'
}

export function BlockedSuggestionsModal({
  show,
  onHide,
}: {
  show: boolean
  onHide: () => void
}) {
  const themed = useThemedModals()
  const [preferences] = useLanguageSuggestionsPreferences()

  return (
    <OLModal show={show} onHide={onHide} themed={themed} className="ai-blocked-suggestions-modal">
      <OLModalHeader>
        <OLModalTitle>Blocked Language Suggestions</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <div className="ai-blocked-suggestions">
          {preferences.blocked.length === 0 ? (
            <>
              <p>
                You can block a suggestion from appearing again by using the{' '}
                <span className="ai-blocked-suggestion-inline-icon">
                  <MaterialIcon type="block" />
                </span>{' '}
                icon on a language suggestion when viewing it in the editor.
                Once you block a suggestion you can view it here. If you block a
                suggestion and then change your mind, you can remove it from
                your blocked language suggestion list.
              </p>
              <SuggestionCard
                preview
                unit={PREVIEW_UNIT}
                active={0}
                onAccept={noop}
                onReject={noop}
                onBlock={noop}
                onActivate={noop}
                onClose={noop}
              />
            </>
          ) : (
            <>
              <p>
                These are your blocked language suggestions. We will not
                suggest any of the suggestions on the list below. You can block
                a suggestion from appearing again by using the{' '}
                <span className="ai-blocked-suggestion-inline-icon">
                  <MaterialIcon type="block" />
                </span>{' '}
                icon on a language suggestion when viewing it in the editor. If
                you want to start seeing a suggestion again you can remove it
                from the list below.
              </p>
              <div className="ai-blocked-suggestions-table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Suggest changing</th>
                      <th scope="col">To</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preferences.blocked.map(entry => (
                      <tr
                        key={blockKey(entry.from, entry.to)}
                        className="ai-blocked-suggestion"
                      >
                        <td>{entry.from || <em className="text-muted">(nothing)</em>}</td>
                        <td>{entry.to || <em className="text-muted">(nothing)</em>}</td>
                        <td className="text-end">
                          <OLButton
                            variant="danger"
                            size="sm"
                            className="ai-blocked-suggestion-delete"
                            aria-label={`Remove "${entry.from}" → "${entry.to}" from blocked list`}
                            onClick={() => unblockSuggestion(entry.from, entry.to)}
                          >
                            Delete
                          </OLButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </OLModalBody>
    </OLModal>
  )
}
