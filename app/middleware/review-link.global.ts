// A link to Tasks to review (utils/reviewLink.ts): the sheet opens, the page stays.
import { reviewRoute } from '~/utils/reviewLink'

export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.server) return
  const stay = reviewRoute(to.path, from.matched.length ? from.fullPath : null)
  if (!stay) return
  showReview()
  return navigateTo(stay, { replace: true })
})
