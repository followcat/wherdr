// { key, policy }: changes a quota account's pace policy (mode, days, cap,
// reserves, end-of-week burn: { until: the reset } turns it on, null off), checked by mergePolicy. The user's only: a coordinator's token reaches /api/pm/cli alone
// (middleware/guard.ts), where `pacing` is refused too (USER_ONLY).
import { ACCOUNT_KEY } from '../../shared/quotaAccount'
import { HerdrError } from '../utils/herdr'
import { setPolicy } from '../utils/pacingPolicies'
import { pacingView } from '../utils/pmPace'

export default defineApi(async (_event, body) => {
  if (typeof body.key !== 'string' || !ACCOUNT_KEY.test(body.key)) throw new HerdrError('bad_account', 'Unknown account')
  if (!body.policy || typeof body.policy !== 'object' || Array.isArray(body.policy)) throw new HerdrError('bad_policy', 'Invalid policy')
  const burn = body.policy.burn
  if (burn !== undefined && burn !== null && (typeof burn !== 'object' || Array.isArray(burn))) throw new HerdrError('bad_policy', 'Invalid burn')
  await setPolicy(body.key, body.policy)
  return pacingView()
})
