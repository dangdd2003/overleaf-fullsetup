import {
  defineGeneratorSession,
  GeneratorAnchor,
  GeneratorPassage,
  GeneratorSession,
  isPassageStale,
} from '../generator/session'

/** The cursor (`from === to`) or the selection the generator was opened on. */
export type EquationAnchor = GeneratorAnchor
/** The editable window around the anchor, and its text when Generate was pressed. */
export type EquationPassage = GeneratorPassage
export type EquationSession = GeneratorSession

export { isPassageStale }

const session = defineGeneratorSession('equation')

/** Non-null exactly while the dialog or the review card is open. */
export const equationField = session.field
export const openEquationDialog = session.openDialog
export const startEquationReview = session.startReview
export const closeEquation = session.close
/** Opens the dialog on the main selection (or on `anchor`); other AI surfaces close. */
export const openEquation = session.open
export const equationExtension = session.extension
