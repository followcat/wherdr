import { describe, expect, it } from 'vitest'
import { dedupe } from '../scripts/llms-merge.mjs'

const base = '# Index\n\n- [A](docs/a.md): a.\n- [B](docs/b.md): b.\n'

describe('dedupe', () => {
  it('keeps the branch\'s line for an entry both sides changed', () => {
    const ours = base.replace('a.', 'a, ours.')
    const union = '# Index\n\n- [A](docs/a.md): a, ours.\n- [A](docs/a.md): a, theirs.\n- [B](docs/b.md): b.\n'
    expect(dedupe(union, ours, base)).toBe('# Index\n\n- [A](docs/a.md): a, ours.\n- [B](docs/b.md): b.\n')
  })

  it('keeps the other side\'s line for an entry the branch left as it was', () => {
    // Only the base's side changed B, but it moved: the union lists it twice.
    const union = '# Index\n\n- [B](docs/b.md): b, theirs.\n- [A](docs/a.md): a.\n- [B](docs/b.md): b.\n'
    expect(dedupe(union, base, base)).toBe('# Index\n\n- [B](docs/b.md): b, theirs.\n- [A](docs/a.md): a.\n')
  })

  it('keeps entries only one side added, and every line\'s order', () => {
    const union = '# Index\n\n- [A](docs/a.md): a.\n- [C](docs/c.md): c.\n- [B](docs/b.md): b.\n- [D](docs/d.md): d.\n'
    expect(dedupe(union, base, base)).toBe(union)
  })

  it('without the sides, keeps the first line of an entry', () => {
    expect(dedupe('- [A](docs/a.md): one.\n- [A](docs/a.md): two.\n')).toBe('- [A](docs/a.md): one.\n')
  })
})
