Implement the five plans below in numeric order — WS1 first, strictly:

- `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws1-bridge-path-targeting.md`
- `.../2026-09-16-ai-assist-editor-tooling-ws2-precision-anchor-apply.md`
- `.../2026-09-16-ai-assist-editor-tooling-ws3-latex-matcher-parity.md`
- `.../2026-09-16-ai-assist-editor-tooling-ws4-compile-feedback-loop.md`
- `.../2026-09-16-ai-assist-editor-tooling-ws5-context-search-hygiene.md`

Read the design doc first for the why, especially its "Rejected Designs" section:
`/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md`

The plans are authoritative and were verified against the source. Follow their
code snippets, TRAP blocks, and "Out of scope" sections as written. Later plans
cite line numbers that WS1 invalidates: if a cited line has drifted, re-read the
file and adapt — never force the snippet.

Work through the tasks sequentially. Do not parallelize edits: WS1–WS5 all touch
`use-project-handle.ts`, and several share `edit-file.ts`, `apply-fix-listener.tsx`
and `compile-project.ts`.

Confirm both test baselines match the plans' Global Constraints before starting,
then TDD each task: failing test, implement, pass. Never run git write commands;
leave everything uncommitted.

At the end, redeploy the ai-assist dev server and report the URL and ports.
