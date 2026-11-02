import { expect, test } from './test'

// Browser languages and legacy preferences never change the English interface.
for (const { locale, saved } of [
  { locale: 'fr-FR', saved: null },
  { locale: 'en-US', saved: 'fr' },
  { locale: 'fr-FR', saved: 'fr' },
]) test.describe(`browser ${locale}, saved ${saved ?? 'none'}`, () => {
  test.use({ locale })
  test('English stays active after a reload', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(value => {
      if (value) localStorage.setItem('herdrLanguage', value)
      else localStorage.removeItem('herdrLanguage')
    }, saved)
    await page.goto('/#/settings?section=appearance')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Home screen', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^(Language|Langue)$/ })).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('herdrLanguage'))).toBe(saved)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Home screen', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^(Language|Langue)$/ })).toHaveCount(0)
  })
})
