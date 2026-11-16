// What search engines and link previews read: the page title and description,
// the sitemap and the structured data. Pure: nuxt.config.ts builds the head
// and sitemap.xml from it, and a root test checks the output.
import { REPO } from './site'

export const SITE_URL = 'https://wherdr.dev'
export const TITLE = 'wherdr — your coding agents on desktop and phone'
export const DESCRIPTION = 'Self-hosted web app and PWA on herdr-core: drive your coding agents and their projects from your desktop or phone. Open source.'
// 1200×630, drawn by tools/og.html.
export const SHARE_IMAGE = { url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: 'wherdr — Your coding agents. Wherever you are.' }

// The indexable pages, each with the files of website/ whose last commit dates it.
// Left out on purpose: /demo/ (the app itself, noindex: no text of its own),
// /install (a shell script) and /llms.txt (an index of links, read at its fixed address).
export const SITEMAP_PAGES = [
  { path: '/', sources: ['app', 'nuxt.config.ts', 'public/og.png'] },
  { path: '/agent.md', sources: ['public/agent.md'] },
] as const

export interface SitemapEntry { path: string, lastmod: string }

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map(e => `  <url>\n    <loc>${xmlEscape(SITE_URL + e.path)}</loc>\n    <lastmod>${xmlEscape(e.lastmod)}</lastmod>\n  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

// schema.org description of wherdr, for the JSON-LD block of the home page.
export const softwareApplication = () => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  'name': 'wherdr',
  'description': DESCRIPTION,
  'url': `${SITE_URL}/`,
  'image': SHARE_IMAGE.url,
  'applicationCategory': 'DeveloperApplication',
  'operatingSystem': 'macOS, Linux',
  'license': 'https://opensource.org/licenses/MIT',
  'isAccessibleForFree': true,
  'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'USD' },
  'installUrl': `${SITE_URL}/install`,
  'softwareHelp': { '@type': 'CreativeWork', 'url': `${SITE_URL}/agent.md` },
  'sameAs': [REPO],
})
