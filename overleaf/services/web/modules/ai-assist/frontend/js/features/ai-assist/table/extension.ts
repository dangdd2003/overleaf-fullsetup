import { Extension } from '@codemirror/state'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { tableExtension } from './session'

/**
 * Loaded by the editor through `sourceEditorExtensions`. The table generator
 * shares the AI gate with Writing tools: with AI off the editor gets nothing.
 */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? tableExtension() : []
