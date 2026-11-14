// Core-mode routes added by v3 project management (lot 7: board and task sheet). See shared/coreRoutes.ts.
// GET pm/handle: the tasks waiting for the user, for the sidebar's Tasks to handle (WHR-52).
// GET pm/agents: each running task agent's task and role, for its sidebar row (WHR-82).
// pm/task-check: Check on GitHub, a stuck merge step's PR read now (WHR-114).
// pm/review-restart: Restart the review, a review that stopped without a verdict (WHR-272).
// pm/worker-start: Start the worker, a merge that waits on it (WHR-278).
// pm/user-shot: a screenshot the user adds to a send-back (WHR-294).
// pm/ask-coordinator: Ask the coordinator, a step it holds that waits on the user (WHR-300).
export default ['GET pm/board', 'GET pm/handle', 'GET pm/agents', 'pm/step-user', 'pm/step-back', 'pm/report', 'pm/task-check', 'pm/review-restart', 'pm/worker-start', 'pm/user-shot', 'pm/ask-coordinator'] as string[]
