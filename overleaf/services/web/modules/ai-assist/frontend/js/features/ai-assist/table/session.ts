import { defineGeneratorSession } from '../generator/session'

const session = defineGeneratorSession('table')

/** Non-null exactly while the dialog or the review card is open. */
export const tableField = session.field
export const openTableDialog = session.openDialog
export const startTableReview = session.startReview
export const closeTable = session.close
/** Opens the dialog on the main selection (or on `anchor`); other AI surfaces close. */
export const openTable = session.open
export const tableExtension = session.extension
