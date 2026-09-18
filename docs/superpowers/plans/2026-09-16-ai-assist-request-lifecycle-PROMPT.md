Implement all 12 tasks in this plan, in numeric order:

`/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-request-lifecycle.md`

Read the spec it links to first (§3 stop policy, §4 orphan reaping) for the why.

The plan is authoritative and was verified against the source: follow its code
snippets, its TRAP blocks, and its "Out of scope" section as written. If a cited
line number has drifted, re-read the file and adapt — don't force the snippet.
Never run git write commands; leave everything uncommitted.

You may use dynamic workflows for parallel read-only work — re-verifying a task's
cited line numbers before you edit, or reviewing your diff against the plan after
each task. Do not use them for concurrent file edits: several tasks share
`AiAssistRunManager.mjs`, `use-agent-run.ts`, and `fix-store.ts`.

Run both test baselines first to confirm your environment matches the numbers in
the plan's Global Constraints, then TDD each task: failing test, implement, pass.
At the end, redeploy the ai-assist dev server and report the URL and ports.
