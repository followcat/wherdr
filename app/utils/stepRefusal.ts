// A failed step action's badge said for people (shared/pm/refusal.ts).
import { refusalSaid, type Told } from '#shared/pm/refusal'

export const stepRefusalText = (badge: string, told?: Told) => tl(refusalSaid(badge, told).long)
