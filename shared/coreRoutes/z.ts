// Core-mode routes added by the model pickers (A7: GET models/efforts are
// read-only; POST model/effort are the session-only switches for
// claude/codex/omp — Devin/OpenCode switch routes land with T5/T6).
// See shared/coreRoutes.ts.
export default ['GET models', 'model', 'GET efforts', 'effort'] as string[]
