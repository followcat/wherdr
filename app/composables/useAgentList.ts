// The agents the user offers (Settings › Agents), for every picker: the
// programs installed on the reachable machines, in the user's order, minus
// those unchecked. The first is the default everywhere.
import { MAIN, canRunCoordinator, isCoordinatorProgram, type CoordinatorAgent, type CoordinatorView } from '#shared/pm/coordinator'
import { offeredAgents, orderAgents } from '~/utils/agentChoices'

// The reachable machines and what each has installed.
export const agentMachines = computed(() => {
  const configured = appConfig.value.machines
  return configured?.filter(m => m.local || (Boolean(m.home) && (machineInfo(m.key)?.status === 'online' || (!machineInfo(m.key) && m.online))))
    || [{ key: '', label: hostLabel.value || t('This machine'), kinds: appConfig.value.kinds }]
})
// Every installed program, in the user's order (Settings lists them all).
export const installedAgents = computed(() => orderAgents(agentMachines.value.flatMap(m => m.kinds || []), agentOrder.value))
// The offered programs among `installed` (one machine's), or among all of them.
export const offerAgents = (installed: readonly string[] = installedAgents.value) => offeredAgents(installed, hiddenAgents.value, agentOrder.value)
// The offered programs that can run Alfred (the main coordinator), or with a
// project key, that project's coordinator (Claude and Codex: see canRunCoordinator).
export const offerCoordinators = (installed?: readonly string[], project: string = MAIN) =>
  offerAgents(installed).filter(isCoordinatorProgram).filter(p => canRunCoordinator(p, project))

// A coordinator's agent: the default the user set for it while still offered,
// else their first agent that can coordinate.
export function coordinatorAgent(c: Pick<CoordinatorView, 'agent' | 'project'>): CoordinatorAgent | undefined {
  const offered = offerCoordinators(undefined, c.project)
  if (c.agent && offered.includes(c.agent.program)) return c.agent
  return offered[0] ? { program: offered[0] } : c.agent
}
