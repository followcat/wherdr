// Core-mode routes added by the model pickers (A7: GET models is read-only;
// POST model is the session-only switch for claude/codex — Devin/omp/OpenCode
// switch routes land with T4/T5/T6). See shared/coreRoutes.ts.
export default ['GET models', 'model'] as string[]
