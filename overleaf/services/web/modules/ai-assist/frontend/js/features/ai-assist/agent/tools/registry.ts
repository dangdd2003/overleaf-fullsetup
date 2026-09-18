import { ToolSpec } from '../../providers/types'
import { ProjectHandle } from '../project-handle'
import { compileProjectTool } from './compile-project'
import { compileResultTool } from './compile-result'
import { createFileTool } from './create-file'
import { editFileTool } from './edit-file'
import { getOutlineTool } from './get-outline'
import { getPackagesTool } from './get-packages'
import { getReferencesTool } from './get-references'
import { listFilesTool } from './list-files'
import { readFileTool } from './read-file'
import { searchTextTool } from './search-text'
import { getProjectSettingsTool } from './get-project-settings'
import { configureAppearanceSettingsTool } from './configure-appearance-settings'
import { configureCompilerSettingsTool } from './configure-compiler-settings'
import { configureEditorSettingsTool } from './configure-editor-settings'
import { listAvailableSettingsTool } from './list-available-settings'

export type AgentTool = {
  spec: ToolSpec
  /** True when the tool needs the user before it can finish. */
  suspends: boolean
  /**
   * True when the tool can change the project.
   *
   * Distinct from `suspends`, which is about control flow: a tool could pause
   * for a reason other than a write. Only tools declaring this receive a
   * write-capable handle (see `readOnlyHandle`), so forgetting it fails
   * closed.
   */
  mutates: boolean
  execute(
    args: any,
    handle: ProjectHandle,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>
  /**
   * Optional plain-text rendering of a result for the model.
   *
   * File content inside JSON is mostly escape sequences. Rendering it as fenced
   * text costs roughly a third fewer tokens and the model quotes it back more
   * accurately. The structured result is still what the transcript stores and
   * what the panel renders.
   */
  render?(result: unknown): string
}

export const TOOLS: Record<string, AgentTool> = {
  get_outline: getOutlineTool,
  get_packages: getPackagesTool,
  get_references: getReferencesTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  search_text: searchTextTool,
  edit_file: editFileTool,
  create_file: createFileTool,
  compile_project: compileProjectTool,
  get_compile_result: compileResultTool,
  get_project_settings: getProjectSettingsTool,
  configure_appearance_settings: configureAppearanceSettingsTool,
  configure_compiler_settings: configureCompilerSettingsTool,
  configure_editor_settings: configureEditorSettingsTool,
  list_available_settings: listAvailableSettingsTool,
}

// Backward-compatible alias that resolves when called but does not clutter the canonical tool surface
Object.defineProperty(TOOLS, 'get_compile_log', {
  value: compileResultTool,
  enumerable: false,
  configurable: true,
  writable: true,
})

export function toolSpecs(): ToolSpec[] {
  // Deduplicate tools so aliases pointing to the same AgentTool do not emit duplicate tool specs to LLM APIs
  const uniqueTools = Array.from(new Set(Object.values(TOOLS)))
  return uniqueTools.map(tool => tool.spec)
}
