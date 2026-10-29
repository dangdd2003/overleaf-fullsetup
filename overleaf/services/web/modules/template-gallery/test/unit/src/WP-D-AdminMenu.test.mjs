import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Features from '../../../../../app/src/infrastructure/Features.mjs'

describe('WP-D Admin menu flag and Features integration', () => {
  it('Features.hasFeature("template-gallery") reflects Settings.enableTemplateGallery', () => {
    const orig = Features.hasFeature('template-gallery')
    expect(typeof orig).toBe('boolean')
  })

  it('locales/en.json translates "templates" to "Templates"', () => {
    const enJsonPath = path.resolve(
      import.meta.dirname,
      '../../../../../locales/en.json'
    )
    const enJson = JSON.parse(fs.readFileSync(enJsonPath, 'utf8'))
    expect(enJson.templates).toBe('Templates')
  })

  it('layout-react.pug passes canDisplayAdminTemplates: hasFeature("template-gallery")', () => {
    const pugPath = path.resolve(
      import.meta.dirname,
      '../../../../../app/views/layout-react.pug'
    )
    const content = fs.readFileSync(pugPath, 'utf8')
    expect(content).toMatch(/canDisplayAdminTemplates:\s*hasFeature\('template-gallery'\)/)
  })

  it('navbar-marketing.pug gates /admin/templates on hasFeature("template-gallery")', () => {
    const pugPath = path.resolve(
      import.meta.dirname,
      '../../../../../app/views/layout/navbar-marketing.pug'
    )
    const content = fs.readFileSync(pugPath, 'utf8')
    expect(content).toMatch(/if hasFeature\('template-gallery'\)[\s\S]*?Manage Templates/)
  })

  it('fat-footer.pug gates /latex/templates on hasFeature("template-gallery")', () => {
    const pugPath = path.resolve(
      import.meta.dirname,
      '../../../../../app/views/layout/fat-footer.pug'
    )
    const content = fs.readFileSync(pugPath, 'utf8')
    expect(content).toMatch(/if hasFeature\('saas'\) \|\| hasFeature\('template-gallery'\)[\s\S]*?\/latex\/templates/)
  })

  it('fat-footer-website-redesign.pug gates /latex/templates on hasFeature("template-gallery")', () => {
    const pugPath = path.resolve(
      import.meta.dirname,
      '../../../../../app/views/layout/fat-footer-website-redesign.pug'
    )
    const content = fs.readFileSync(pugPath, 'utf8')
    expect(content).toMatch(/if hasFeature\('saas'\) \|\| hasFeature\('template-gallery'\)[\s\S]*?\/latex\/templates/)
  })

  it('default-navbar-metadata.ts declares optional canDisplayAdminTemplates', () => {
    const tsPath = path.resolve(
      import.meta.dirname,
      '../../../../../frontend/js/shared/components/types/default-navbar-metadata.ts'
    )
    const content = fs.readFileSync(tsPath, 'utf8')
    expect(content).toMatch(/canDisplayAdminTemplates\?: boolean/)
  })

  it('admin-menu.tsx includes canDisplayAdminTemplates and links to /admin/templates', () => {
    const tsxPath = path.resolve(
      import.meta.dirname,
      '../../../../../frontend/js/shared/components/navbar/admin-menu.tsx'
    )
    const content = fs.readFileSync(tsxPath, 'utf8')
    expect(content).toContain('canDisplayAdminTemplates')
    expect(content).toContain('/admin/templates')
    expect(content).toContain('Manage Templates')
  })
})
