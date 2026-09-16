import { useMemo } from 'react'
import {
  useUserSettingsContext,
  defaultSettings,
} from '@/shared/context/user-settings-context'
import { useActiveEditorTheme } from '@/shared/hooks/use-active-editor-theme'
import { useActiveOverallTheme } from '@/shared/hooks/use-active-overall-theme'
import { userStyles, FontFamily, LineHeight } from '@/shared/utils/styles'

export interface EditorThemePalette {
  bg: string
  fg: string
  gutterBg: string
  gutterFg: string
  gutterBorder?: string
  dark: boolean
}

export const EDITOR_THEME_PALETTES: Record<string, EditorThemePalette> = {
  ambiance: {
    bg: '#202020',
    fg: '#E6E1DC',
    gutterBg: '#3d3d3d',
    gutterFg: '#222',
    gutterBorder: 'transparent',
    dark: true,
  },
  chaos: {
    bg: '#161616',
    fg: '#E6E1DC',
    gutterBg: '#141414',
    gutterFg: '#595959',
    gutterBorder: 'transparent',
    dark: true,
  },
  chrome: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#ebebeb',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  clouds: {
    bg: '#FFFFFF',
    fg: '#000000',
    gutterBg: '#ebebeb',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  clouds_midnight: {
    bg: '#191919',
    fg: '#929292',
    gutterBg: '#232323',
    gutterFg: '#929292',
    gutterBorder: 'transparent',
    dark: true,
  },
  cobalt: {
    bg: '#002240',
    fg: '#FFFFFF',
    gutterBg: '#011e3a',
    gutterFg: 'rgb(128,145,160)',
    gutterBorder: 'transparent',
    dark: true,
  },
  crimson_editor: {
    bg: '#FFFFFF',
    fg: 'rgb(64, 64, 64)',
    gutterBg: '#ebebeb',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  dawn: {
    bg: '#F9F9F9',
    fg: '#080808',
    gutterBg: '#ebebeb',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  dracula: {
    bg: '#282a36',
    fg: '#f8f8f2',
    gutterBg: '#282a36',
    gutterFg: 'rgb(144,145,148)',
    gutterBorder: 'transparent',
    dark: true,
  },
  dreamweaver: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#e8e8e8',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  eclipse: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#ebebeb',
    gutterFg: 'rgb(136, 136, 136)',
    gutterBorder: 'transparent',
    dark: false,
  },
  github: {
    bg: '#ffffff',
    fg: '#000000',
    gutterBg: '#e8e8e8',
    gutterFg: '#AAA',
    gutterBorder: 'transparent',
    dark: false,
  },
  gob: {
    bg: '#0B0B0B',
    fg: '#00FF00',
    gutterBg: '#0B1818',
    gutterFg: '#03EE03',
    gutterBorder: 'transparent',
    dark: true,
  },
  gruvbox: {
    bg: '#1D2021',
    fg: '#EBDAB4',
    gutterBg: '#1D2021',
    gutterFg: '#888888',
    gutterBorder: 'transparent',
    dark: true,
  },
  idle_fingers: {
    bg: '#323232',
    fg: '#FFFFFF',
    gutterBg: '#3b3b3b',
    gutterFg: 'rgb(153,153,153)',
    gutterBorder: 'transparent',
    dark: true,
  },
  iplastic: {
    bg: '#eeeeee',
    fg: '#333333',
    gutterBg: '#dddddd',
    gutterFg: '#666666',
    gutterBorder: 'transparent',
    dark: false,
  },
  katzenmilch: {
    bg: '#f3f2f3',
    fg: 'rgba(15, 0, 9, 1.0)',
    gutterBg: '#e8e8e8',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  kr_theme: {
    bg: '#0B0A09',
    fg: '#FCFFE0',
    gutterBg: '#1c1917',
    gutterFg: '#FCFFE0',
    gutterBorder: 'transparent',
    dark: true,
  },
  kuroir: {
    bg: '#E8E9E8',
    fg: '#363636',
    gutterBg: '#e8e8e8',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  merbivore: {
    bg: '#161616',
    fg: '#E6E1DC',
    gutterBg: '#202020',
    gutterFg: '#E6E1DC',
    gutterBorder: 'transparent',
    dark: true,
  },
  merbivore_soft: {
    bg: '#1C1C1C',
    fg: '#E6E1DC',
    gutterBg: '#262424',
    gutterFg: '#E6E1DC',
    gutterBorder: 'transparent',
    dark: true,
  },
  mono_industrial: {
    bg: '#222C28',
    fg: '#FFFFFF',
    gutterBg: '#1d2521',
    gutterFg: '#C5C9C9',
    gutterBorder: 'transparent',
    dark: true,
  },
  monokai: {
    bg: '#272822',
    fg: '#F8F8F2',
    gutterBg: '#2F3129',
    gutterFg: '#8F908A',
    gutterBorder: 'transparent',
    dark: true,
  },
  nord_dark: {
    bg: '#2e3440',
    fg: '#d8dee9',
    gutterBg: '#2e3440',
    gutterFg: '#616e88',
    gutterBorder: 'transparent',
    dark: true,
  },
  one_dark: {
    bg: '#282c34',
    fg: '#abb2bf',
    gutterBg: '#282c34',
    gutterFg: '#6a6f7a',
    gutterBorder: 'transparent',
    dark: true,
  },
  overleaf: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#f0f0f0',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  overleaf_dark: {
    bg: '#1b222c',
    fg: '#f8f8f2',
    gutterBg: '#1b222c',
    gutterFg: 'rgb(144,145,148)',
    gutterBorder: 'transparent',
    dark: true,
  },
  pastel_on_dark: {
    bg: '#2C2828',
    fg: '#8F938F',
    gutterBg: '#353030',
    gutterFg: '#8F938F',
    gutterBorder: 'transparent',
    dark: true,
  },
  solarized_dark: {
    bg: '#002B36',
    fg: '#93A1A1',
    gutterBg: '#01313f',
    gutterFg: '#d0edf7',
    gutterBorder: 'transparent',
    dark: true,
  },
  solarized_light: {
    bg: '#FDF6E3',
    fg: '#586E75',
    gutterBg: '#fbf1d3',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  sqlserver: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#ebebeb',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  terminal: {
    bg: '#000000',
    fg: '#DEDEDE',
    gutterBg: '#1a0005',
    gutterFg: 'steelblue',
    gutterBorder: 'transparent',
    dark: true,
  },
  textmate: {
    bg: '#FFFFFF',
    fg: 'black',
    gutterBg: '#f0f0f0',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
  tomorrow: {
    bg: '#FFFFFF',
    fg: '#4D4D4C',
    gutterBg: '#f6f6f6',
    gutterFg: '#4D4D4C',
    gutterBorder: 'transparent',
    dark: false,
  },
  tomorrow_night: {
    bg: '#1D1F21',
    fg: '#C5C8C6',
    gutterBg: '#25282c',
    gutterFg: '#C5C8C6',
    gutterBorder: 'transparent',
    dark: true,
  },
  tomorrow_night_blue: {
    bg: '#002451',
    fg: '#FFFFFF',
    gutterBg: '#00204b',
    gutterFg: '#7388b5',
    gutterBorder: 'transparent',
    dark: true,
  },
  tomorrow_night_bright: {
    bg: '#000000',
    fg: '#DEDEDE',
    gutterBg: '#1a1a1a',
    gutterFg: '#DEDEDE',
    gutterBorder: 'transparent',
    dark: true,
  },
  tomorrow_night_eighties: {
    bg: '#2D2D2D',
    fg: '#CCCCCC',
    gutterBg: '#272727',
    gutterFg: '#CCC',
    gutterBorder: 'transparent',
    dark: true,
  },
  twilight: {
    bg: '#141414',
    fg: '#F8F8F8',
    gutterBg: '#232323',
    gutterFg: '#E2E2E2',
    gutterBorder: 'transparent',
    dark: true,
  },
  vibrant_ink: {
    bg: '#0F0F0F',
    fg: '#FFFFFF',
    gutterBg: '#1a1a1a',
    gutterFg: '#BEBEBE',
    gutterBorder: 'transparent',
    dark: true,
  },
  xcode: {
    bg: '#FFFFFF',
    fg: '#000000',
    gutterBg: '#e8e8e8',
    gutterFg: '#333',
    gutterBorder: 'transparent',
    dark: false,
  },
}

export function useEditorThemeStyles() {
  let userSettings = defaultSettings
  try {
    const context = useUserSettingsContext()
    if (context?.userSettings) {
      userSettings = context.userSettings
    }
  } catch {
    // Graceful fallback outside UserSettingsProvider (e.g. testing)
  }

  let editorTheme = 'textmate'
  try {
    editorTheme = useActiveEditorTheme() || 'textmate'
  } catch {
    editorTheme = userSettings.editorTheme || 'textmate'
  }

  let activeOverallTheme: 'dark' | 'light' = 'light'
  try {
    activeOverallTheme = useActiveOverallTheme() === 'dark' ? 'dark' : 'light'
  } catch {
    activeOverallTheme = (userSettings.overallTheme as string) === 'dark' ? 'dark' : 'light'
  }

  const {
    fontFamily = 'monaco',
    fontSize = 12,
    lineHeight = 'normal',
  } = userSettings

  const styles = useMemo(() => {
    return userStyles({
      fontFamily: fontFamily as FontFamily,
      fontSize,
      lineHeight: lineHeight as LineHeight,
    })
  }, [fontFamily, fontSize, lineHeight])

  const palette: EditorThemePalette = useMemo(() => {
    if (EDITOR_THEME_PALETTES[editorTheme]) {
      return EDITOR_THEME_PALETTES[editorTheme]
    }
    return activeOverallTheme === 'dark'
      ? EDITOR_THEME_PALETTES.overleaf_dark
      : EDITOR_THEME_PALETTES.textmate
  }, [editorTheme, activeOverallTheme])

  const isDark = Boolean(palette.dark || activeOverallTheme === 'dark')

  const editorStyle = useMemo(
    () =>
      ({
        '--font-size': styles.fontSize,
        '--source-font-family': styles.fontFamily,
        '--line-height': String(styles.lineHeight),
        '--editor-bg': palette.bg,
        '--editor-fg': palette.fg,
        '--gutter-bg': palette.gutterBg,
        '--gutter-fg': palette.gutterFg,
        '--gutter-border':
          palette.gutterBorder && palette.gutterBorder !== 'transparent'
            ? palette.gutterBorder
            : isDark
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(0, 0, 0, 0.08)',
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        lineHeight: styles.lineHeight,
        backgroundColor: palette.bg,
        color: palette.fg,
      } as React.CSSProperties),
    [styles, palette, isDark]
  )

  const gutterStyle = useMemo(
    () =>
      ({
        backgroundColor: palette.gutterBg,
        color: palette.gutterFg,
        borderRightColor:
          palette.gutterBorder && palette.gutterBorder !== 'transparent'
            ? palette.gutterBorder
            : isDark
            ? 'rgba(255, 255, 255, 0.08)'
            : 'rgba(0, 0, 0, 0.08)',
      } as React.CSSProperties),
    [palette, isDark]
  )

  return {
    editorTheme,
    activeOverallTheme,
    palette,
    isDark,
    styles,
    editorStyle,
    gutterStyle,
  }
}
