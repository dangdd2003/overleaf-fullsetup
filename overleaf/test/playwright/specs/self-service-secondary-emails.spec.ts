import { test, expect } from '@playwright/test'

const BASE_URL = process.env.OVERLEAF_URL || 'http://localhost'
const USER_EMAIL = process.env.TEST_USER_EMAIL || 'dangdoan2206@gmail.com'
const USER_PASSWORD = process.env.TEST_USER_PASSWORD || 'password'
const SECONDARY_EMAIL = `test.secondary.${Date.now()}@example.com`

test.describe('Self-Service Secondary Emails in Overleaf CE', () => {
  test('adds, promotes to primary, and deletes a secondary email without affiliations', async ({
    page,
  }) => {
    // 1. Log in
    await page.goto(`${BASE_URL}/login`)
    await page.fill('input[name="email"], input[type="email"]', USER_EMAIL)
    await page.fill(
      'input[name="password"], input[type="password"]',
      USER_PASSWORD
    )
    await page.click('button[type="submit"]')

    // Wait for navigation after login
    await page.waitForURL(url => !url.pathname.includes('/login'), {
      timeout: 15000,
    })

    // 2. Navigate to Account Settings
    await page.goto(`${BASE_URL}/user/settings`)
    await page.waitForSelector('text=Emails', { timeout: 10000 })

    // Verify simplified table header
    await expect(page.locator('text=Emails and affiliations')).not.toBeVisible()
    await expect(page.locator('text=Institution and role')).not.toBeVisible()
    await expect(page.locator('strong:has-text("Email")')).toBeVisible()
    await expect(page.locator('strong:has-text("Actions")')).toBeVisible()

    // 3. Add a secondary email
    await page.click('button:has-text("Add another email")')
    await page.waitForSelector('#simple-secondary-email-input')
    await page.fill('#simple-secondary-email-input', SECONDARY_EMAIL)
    await page.click('button:has-text("Add email")')

    // 4. Verify email appears immediately confirmed
    await expect(page.locator(`text=${SECONDARY_EMAIL}`)).toBeVisible({
      timeout: 10000,
    })
    await expect(
      page
        .locator(`text=${SECONDARY_EMAIL}`)
        .locator('..')
        .locator('text=Unconfirmed')
    ).not.toBeVisible()

    // Capture screenshot of added secondary email
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-added.png',
      fullPage: true,
    })

    // 5. Promote secondary email to Primary
    const secondaryRow = page.locator(
      `[data-testid="simple-email-row"]:has-text("${SECONDARY_EMAIL}")`
    )
    await secondaryRow.locator('button:has-text("Make primary")').click()

    // Confirm modal
    await page.waitForSelector('.modal-dialog')
    await page.click(
      '.modal-dialog button:has-text("Change primary email"), .modal-dialog button:has-text("Make primary"), .modal-dialog button:has-text("Confirm")'
    )

    // Verify Primary badge moved to secondary email
    await expect(secondaryRow.locator('text=Primary')).toBeVisible({
      timeout: 10000,
    })

    // Capture screenshot of promoted email
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-promoted.png',
      fullPage: true,
    })

    // 6. Delete old primary (which is now secondary)
    const oldPrimaryRow = page.locator(
      `[data-testid="simple-email-row"]:has-text("${USER_EMAIL}")`
    )
    await oldPrimaryRow
      .locator('button[aria-label="Remove"], button[aria-label="remove"]')
      .click()

    // Verify old email disappeared from list
    await expect(oldPrimaryRow).not.toBeVisible({
      timeout: 10000,
    })

    // Capture screenshot after deletion
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-deleted.png',
      fullPage: true,
    })
  })
})
