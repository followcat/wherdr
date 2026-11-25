// Backlot's stage/server daemons are infrastructure terminals, never agents:
// one predicate shared by the Home list, the alerts and the backlot document reader.
export interface BacklotDaemonFields {
  name?: string | null
  labels?: Record<string, string>
  backlotRole?: string | null
}

export function isBacklotDaemonTerminal(t: BacklotDaemonFields): boolean {
  const role = t.labels?.['backlot.role'] ?? t.backlotRole
  return t.name === 'backlot-stage' || t.name === 'backlot-server' || role === 'stage' || role === 'server'
}
