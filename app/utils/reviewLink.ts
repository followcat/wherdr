// #/review (and #/decisions, the former Decisions page) opens Tasks to review
// over the page the user is on; the app started on it: over Home.
import { REVIEW_PATHS } from '../../shared/appLinks'

// from: the page shown (its full path), null while the app starts. The page to
// stay on, or null for any other address. A redirect, never an abort: Nuxt
// shows an abort while the app starts as a 404.
export function reviewRoute(to: string, from: string | null): string | null {
  if (!REVIEW_PATHS.includes(to)) return null
  return from && !REVIEW_PATHS.includes(from.split('?')[0]!) ? from : '/'
}
