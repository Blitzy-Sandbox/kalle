import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: '#EFEFF4',
        nav: '#F6F6F6',
        statusbar: '#F7F7F7',
        secondary: '#8E8E93',
        link: '#007AFF',
        destructive: '#FF3B30',
        disabled: '#D1D1D6',
        'icon-dark': '#060606',
        separator: 'rgba(60, 60, 67, 0.29)',
        'nav-shadow': 'rgba(166, 166, 170, 1)',
        'msg-sent': '#DCF8C6',
        'toggle-green': '#4CD964',
        'icon-yellow': '#FFCC00',
        'whatsapp-green': '#25D366',
        'icon-purple': '#AF52DE',
        'blue-ios': '#007AFF',
        'red-ios': '#FF3B30',
        'icon-teal': '#00BCD4',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
      },
      boxShadow: {
        'nav': '0px 0.33px 0px rgba(166, 166, 170, 1)',
        'tab': '0px -0.33px 0px rgba(166, 166, 170, 1)',
        'card': '0px 0.33px 0px rgba(60, 60, 67, 0.29)',
      },
    },
  },
  plugins: [],
};

export default config;
