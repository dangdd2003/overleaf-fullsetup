import React from 'react'
import { expect } from 'chai'
import { renderHook } from '@testing-library/react'
import {
  useEditorThemeStyles,
  EDITOR_THEME_PALETTES,
} from '../../../../frontend/js/features/ai-assist/hooks/use-editor-theme-styles'
import {
  UserSettingsContext,
  defaultSettings,
} from '@/shared/context/user-settings-context'

describe('useEditorThemeStyles', function () {
  it('provides palettes for known themes including monokai and textmate', function () {
    expect(EDITOR_THEME_PALETTES.monokai).to.exist
    expect(EDITOR_THEME_PALETTES.monokai.bg).to.equal('#272822')
    expect(EDITOR_THEME_PALETTES.monokai.fg).to.equal('#F8F8F2')
    expect(EDITOR_THEME_PALETTES.monokai.dark).to.be.true

    expect(EDITOR_THEME_PALETTES.textmate).to.exist
    expect(EDITOR_THEME_PALETTES.textmate.bg).to.equal('#FFFFFF')
    expect(EDITOR_THEME_PALETTES.textmate.dark).to.be.false
  })

  it('falls back safely when used outside UserSettingsProvider', function () {
    const { result } = renderHook(() => useEditorThemeStyles())
    expect(result.current.styles).to.exist
    expect(result.current.styles.fontSize).to.exist
    expect(result.current.editorStyle).to.exist
    expect(result.current.gutterStyle).to.exist
  })

  it('inherits custom font size, font family and dark theme from UserSettingsContext', function () {
    const customSettings = {
      ...defaultSettings,
      editorTheme: 'monokai',
      fontFamily: 'lucida' as const,
      fontSize: 16,
      lineHeight: 'wide' as const,
      overallTheme: 'dark' as any,
    }

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <UserSettingsContext.Provider
        value={{
          userSettings: customSettings,
          setUserSettings: () => {},
        }}
      >
        {children}
      </UserSettingsContext.Provider>
    )

    const { result } = renderHook(() => useEditorThemeStyles(), { wrapper })

    expect(result.current.editorTheme).to.equal('monokai')
    expect(result.current.isDark).to.be.true
    expect(result.current.palette.bg).to.equal('#272822')
    expect(result.current.styles.fontSize).to.equal('16px')
    expect(result.current.styles.fontFamily).to.contain('Lucida Console')
    expect(result.current.styles.lineHeight).to.equal(2)
    expect(result.current.editorStyle.fontFamily).to.contain('Lucida Console')
    expect(result.current.editorStyle.fontSize).to.equal('16px')
    expect(result.current.editorStyle.backgroundColor).to.equal('#272822')
  })
})
