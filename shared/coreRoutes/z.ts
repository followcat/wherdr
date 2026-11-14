// Core-mode routes: a machine's keep awake (WHR-140: Settings › Machines), and
// the model pickers' (A7: GET models/efforts are read-only; POST model/effort
// are the session-only switches for claude/codex/omp — Devin/OpenCode switch
// routes land with T5/T6). See shared/coreRoutes.ts.
export default ['machine/awake', 'GET models', 'model', 'GET efforts', 'effort'] as string[]
