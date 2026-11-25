import type { Config } from 'tailwindcss';

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        'surface-2': v('surface-2'),
        'surface-3': v('surface-3'),
        ink: v('ink'),
        'ink-2': v('ink-2'),
        'ink-3': v('ink-3'),
        line: v('line'),
        'line-2': v('line-2'),
        accent: v('accent'),
        'accent-2': v('accent-2'),
        'accent-soft': v('accent-soft'),
        'on-accent': v('on-accent'),
        ok: v('ok'),
        'ok-soft': v('ok-soft'),
        warn: v('warn'),
        'warn-soft': v('warn-soft'),
        crit: v('crit'),
        'crit-soft': v('crit-soft'),
        info: v('info'),
        'info-soft': v('info-soft'),
      },
      fontFamily: {
        display: ['var(--font-display)', 'Segoe UI', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
