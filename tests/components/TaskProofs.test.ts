import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TaskProofs from '~/components/TaskProofs.vue'

const report = '## Review fix\n\n- `docs/installation.md`: one line per step'
const sha = '0123456789abcdef0123456789abcdef01234567'

it('renders a step\'s proofs: Markdown once, a short sha chip linked to its commit, a PR link labelled', async () => {
  const w = await mountSuspended(TaskProofs, { props: {
    proofs: [['report', report], ['proposed-tasks', `${report}\n`], ['commit', sha], ['link', 'https://github.com/o/r/pull/673']],
    links: [{ label: 'PR', url: 'https://github.com/o/r/pull/673' }],
  } })
  // Markdown, not its marks (happy-dom's DOMPurify drops headings, a browser keeps them); the
  // same text as proposed-tasks shown once.
  const texts = w.findAll('.task-proof-text')
  expect(texts.map(t => t.attributes('data-proof'))).toEqual(['report'])
  expect(texts[0]!.find('li code').text()).toBe('docs/installation.md')
  expect(texts[0]!.text()).not.toContain('##')
  const commit = w.get('[data-proof="commit"] a')
  expect(commit.text()).toBe('0123456')
  expect(commit.attributes('href')).toBe(`https://github.com/o/r/commit/${sha}`)
  expect(w.get('[data-proof="link"] a').text()).toBe('PR #673')
  w.unmount()
})

it('a commit without a known Git host is a chip with no link', async () => {
  const w = await mountSuspended(TaskProofs, { props: { proofs: [['commit', sha]], links: [] } })
  expect(w.find('[data-proof="commit"] a').exists()).toBe(false)
  expect(w.get('[data-proof="commit"] .board-chip').text()).toBe('0123456')
  w.unmount()
})
