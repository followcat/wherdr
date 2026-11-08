// { key, name }: names a quota account ('' removes the name). The user's only:
// a coordinator's token reaches /api/pm/cli alone (middleware/guard.ts).
import { ACCOUNT_KEY } from '../../../shared/quotaAccount'
import { setAccountName } from '../../utils/accountNames'
import { HerdrError } from '../../utils/herdr'
import { forgetQuotas } from '../../utils/quotas'

export default defineApi(async (_event, body) => {
  if (typeof body.key !== 'string' || !ACCOUNT_KEY.test(body.key)) throw new HerdrError('bad_account', 'Unknown account')
  if (typeof body.name !== 'string') throw new HerdrError('bad_name', 'Invalid name')
  const names = await setAccountName(body.key, body.name)
  forgetQuotas()
  return { key: body.key, name: names[body.key] ?? null }
})
