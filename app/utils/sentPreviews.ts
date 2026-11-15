// Photos just sent: the local preview of each (the picked file's blob URL) is
// kept by its uploaded name after Send, so the bubble shows it at once and
// until its uploaded copy has loaded (components/ThumbImg.vue).
import { uploadSrc } from '#shared/queuedMatch'

const KEEP_MS = 10 * 60_000
const previews = new Map<string, { url: string, timer: ReturnType<typeof setTimeout> }>()

export function keepPreview(name: string, url: string) {
  const src = uploadSrc(name)
  dropPreview(src)
  previews.set(src, { url, timer: setTimeout(() => dropPreview(src), KEEP_MS) })
}
export const previewFor = (src: string): string | null => previews.get(src)?.url ?? null
export function dropPreview(src: string) {
  const p = previews.get(src)
  if (!p) return
  clearTimeout(p.timer)
  previews.delete(src)
  URL.revokeObjectURL(p.url)
}
