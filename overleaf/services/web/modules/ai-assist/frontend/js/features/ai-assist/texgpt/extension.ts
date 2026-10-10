import { Extension } from '@codemirror/state'
import { isWritingToolsAvailable } from '../writing-tools/availability'
import { texGptExtension } from './target'

/**
 * Loaded by the editor through `sourceEditorExtensions`. TeXGPT shares the
 * AI gate with Writing tools: with AI off the editor gets nothing.
 */
export const extension = (): Extension =>
  isWritingToolsAvailable() ? texGptExtension() : []
