import { Extension } from '@codemirror/state'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { equationExtension } from './session'

/**
 * Loaded by the editor through `sourceEditorExtensions`. The equation
 * generator shares the AI gate with Writing tools: with AI off the editor
 * gets nothing.
 */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? equationExtension() : []
