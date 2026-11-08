import { expect, it } from 'vitest'
import { ref } from 'vue'
import { NONE, fromNone, noneModel, orNone } from '../app/utils/selectNone'

it('maps the app\'s empty choice to a value USelect accepts, and back', () => {
  expect(orNone('')).toBe(NONE)
  expect(orNone(undefined)).toBe(NONE)
  expect(orNone('CO')).toBe('CO')
  expect(fromNone(NONE)).toBe('')
  expect(fromNone(null)).toBe('')
  expect(fromNone('CO')).toBe('CO')
  const project = ref('')
  const pick = noneModel(project)
  expect(pick.value).toBe(NONE)
  pick.value = 'CO'
  expect(project.value).toBe('CO')
  pick.value = NONE
  expect(project.value).toBe('')
})
