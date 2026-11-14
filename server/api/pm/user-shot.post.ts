// ?task=, the image as the body: a screenshot the user adds to a send-back
// (the review sheet's Reject), from their passkey session.
import { SHOT_MAX_BYTES } from '../../../shared/pm/shots'
import { userShot } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'

export default defineApi((event, b) => userShot(pmStore(), getQuery(event).task, b.data, b.ctype),
  { raw: /^image\/(png|jpeg|webp)$/, max: SHOT_MAX_BYTES, tooLarge: 'Image too large (10 MB max)' })
