/**
 * Patterns shared by the selection measure and the LaTeX check. All are
 * global: use them with `matchAll` / `replace`, never with `test`, which
 * would carry `lastIndex` between calls.
 */

/** Inline and display math: $$…$$, $…$, \(…\), \[…\]. An escaped \$ is prose. */
export const MATH_PATTERN =
  /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$(?:\\.|[^$\\])+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g

/**
 * Commands whose argument is a key rather than prose. Groups: 1 = command
 * name, 2 = optional arguments, 3 = comma-separated keys.
 */
export const KEYED_COMMAND_PATTERN =
  /\\([a-zA-Z]*cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|pageref|label)\*?((?:\[[^\]]*\]){0,2})\{([^}]*)\}/g

/** A % comment to the end of the line; \% is a literal percent sign. */
export const COMMENT_PATTERN = /(^|[^\\])%.*$/gm
