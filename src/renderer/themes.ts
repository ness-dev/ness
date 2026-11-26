export type ThemeMode = 'light' | 'dark'

export interface ThemeOption {
  id: string
  label: string
  description: string
  swatches: string[]
  mode: ThemeMode
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'Neutral dark — the default Ness look.',
    swatches: ['#0a0a0a', '#262626', '#d4d4d4', '#22c55e'],
    mode: 'dark'
  },
  {
    id: 'dracula',
    label: 'Dracula',
    description: 'The iconic purple-tinted dark theme.',
    swatches: ['#282a36', '#44475a', '#f8f8f2', '#bd93f9'],
    mode: 'dark'
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Arctic, north-bluish clean and elegant.',
    swatches: ['#2e3440', '#434c5e', '#d8dee9', '#88c0d0'],
    mode: 'dark'
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    description: 'Retro groove warm earth tones.',
    swatches: ['#282828', '#3c3836', '#ebdbb2', '#fabd2f'],
    mode: 'dark'
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Inspired by the neon lights of downtown Tokyo.',
    swatches: ['#1a1b26', '#292e42', '#c0caf5', '#7aa2f7'],
    mode: 'dark'
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Soothing pastel theme, mocha flavor.',
    swatches: ['#1e1e2e', '#313244', '#cdd6f4', '#cba6f7'],
    mode: 'dark'
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    description: 'Atom’s classic dark theme.',
    swatches: ['#282c34', '#3e4451', '#abb2bf', '#61afef'],
    mode: 'dark'
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Ethan Schoonover’s classic low-contrast dark palette.',
    swatches: ['#002b36', '#073642', '#93a1a1', '#268bd2'],
    mode: 'dark'
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Neutral light — the default Ness look, on paper.',
    swatches: ['#ffffff', '#ebebeb', '#262626', '#16a34a'],
    mode: 'light'
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    description: 'Soothing pastel theme, latte flavor.',
    swatches: ['#eff1f5', '#dce0e8', '#4c4f69', '#8839ef'],
    mode: 'light'
  },
  {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    description: 'Retro groove on warm parchment.',
    swatches: ['#fbf1c7', '#ebdbb2', '#3c3836', '#af3a03'],
    mode: 'light'
  },
  {
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    description: 'Tokyo Night in daylight — cool lilac greys, blue ink.',
    swatches: ['#e1e2e7', '#c9cddc', '#3760bf', '#9854f1'],
    mode: 'light'
  },
  {
    id: 'one-light',
    label: 'One Light',
    description: 'Atom’s classic light theme.',
    swatches: ['#fafafa', '#e5e5e6', '#383a42', '#4078f2'],
    mode: 'light'
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    description: 'The light half of Solarized — easy on the eyes in daylight.',
    swatches: ['#fdf6e3', '#eee8d5', '#586e75', '#268bd2'],
    mode: 'light'
  },
  {
    id: 'cyberfunk',
    label: 'Cyberfunk',
    description: 'Pitch-black neon — magenta wiring, orange sparks.',
    swatches: ['#000000', '#1f0033', '#ff00ff', '#ff6600'],
    mode: 'dark'
  }
]

export const BUILT_IN_THEMES_BY_MODE: { light: ThemeOption[]; dark: ThemeOption[] } = {
  light: THEME_OPTIONS.filter((t) => t.mode === 'light'),
  dark: THEME_OPTIONS.filter((t) => t.mode === 'dark')
}
