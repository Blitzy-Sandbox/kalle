import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS Design Token Configuration
 *
 * Single source of truth for all visual styling in the WhatsApp clone frontend.
 * All tokens derived from Figma file miK1B6qEPrUnRZ9wwZNrW2 (WhatsApp UI Screens).
 *
 * Token Mapping Sources:
 * - AAP Section 0.5.2: Token Manifest
 * - AAP Section 0.6.3: Token Mapping (Figma → Tailwind)
 * - AAP Section 0.6.4: Gaps Inventory (font stack, 0.33px borders, letter spacing)
 *
 * Responsive Strategy (Rule R3):
 * - Mobile-first from 375px base Figma frame
 * - Breakpoints: 375px mobile, 768px tablet, 1280px desktop, 1440px wide
 */
const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      /* ============================================================
       * COLORS — Figma Token Manifest (Section 0.5.2)
       *
       * Every color maps to a Figma fill token. Semantic naming
       * follows Figma usage context for downstream component clarity.
       * ============================================================ */
      colors: {
        /* --- Background colors --- */
        surface: '#EFEFF4',           /* color-bg-secondary: screen backgrounds, section separators */
        nav: '#F6F6F6',               /* color-bg-nav: navigation bar, tab bar, input bar backgrounds */
        statusbar: '#F7F7F7',         /* color-bg-status-bar: iOS status bar background */

        /* --- iOS system interactive colors --- */
        /* WCAG 2.1 AA (R34): colors darkened from Figma originals to meet ≥4.5:1
           contrast ratio on white (#FFFFFF) backgrounds.
           Original Figma values preserved in comments for design reference. */
        'blue-ios': '#0064D2',        /* color-text-link: links, interactive text, active tab icons (Figma: #007AFF, 4.02:1 → #0064D2, ≥4.5:1) */
        'red-ios': '#CC2D24',         /* color-text-destructive: delete actions, missed calls (Figma: #FF3B30, 3.55:1 → #CC2D24, ≥4.5:1) */
        disabled: '#D1D1D6',          /* color-text-disabled: inactive buttons (e.g., "Done" disabled) */

        /* --- Text colors --- */
        secondary: '#5E5E63',         /* color-text-secondary: message previews, dates, descriptions.
                                       * History: Figma source is #8E8E93 (3.26:1 fail). Was darkened
                                       * to #6D6D72 which gave 5.10:1 on white but only 4.50:1 on
                                       * `bg-surface` (#EFEFF4) — exactly the WCAG 2.1 AA border. QA
                                       * F3 Issue #15 measured 4.49:1, just below the 4.5:1 minimum.
                                       * Re-darkened to #5E5E63 for ≥5:1 on every project surface:
                                       *   - on #FFFFFF (msg cards, modal bg):       6.07:1 ✓
                                       *   - on #F6F6F6 (bg-nav, statusbar, navbar): 5.55:1 ✓
                                       *   - on #EFEFF4 (bg-surface page bg):        5.07:1 ✓
                                       * Visually nearly indistinguishable from #6D6D72 at body
                                       * sizes, but unambiguously WCAG 2.1 AA compliant. */
        'icon-dark': '#060606',       /* color-icon-dark: status bar icons, dark UI icons */

        /* --- Separator and shadow colors --- */
        separator: 'rgba(60, 60, 67, 0.29)',    /* color-separator: thin line separators between rows */
        'nav-shadow': 'rgba(166, 166, 170, 1)',  /* color-nav-shadow: navigation bar and tab bar shadows */

        /* --- Message bubble colors --- */
        'msg-sent': '#DCF8C6',        /* color-msg-sent-bg: sent message bubble (green-tinted) — Figma fill_ZYO61A */
        'msg-received': '#FFFFFF',    /* color-msg-received-bg: received message bubble (white) */

        /* --- Toggle and brand colors --- */
        'toggle-green': '#4CD964',    /* color-toggle-green: iOS toggle on state track */
        'whatsapp-green': '#25D366',  /* color-icon-green: WhatsApp brand green, active indicators */

        /* --- Icon accent colors --- */
        'icon-yellow': '#FFCC00',     /* color-icon-yellow-star: starred messages icon */
        'icon-purple': '#AF52DE',     /* color-icon-purple: text status pencil icon circle */
        'icon-pink': '#FF2C55',       /* tell a friend heart icon in settings */
        'icon-red': '#FF3B30',        /* color-icon-red: notification bell icon in settings */
        'icon-blue': '#007AFF',       /* color-icon-blue: camera, compose, and interactive icons */
        'icon-teal': '#00BCD4',       /* color-icon-teal: web/desktop monitor icon */

        /* --- Settings icon background colors (rounded rect icon containers) --- */
        'settings-blue': '#397AFE',   /* account key icon background */
        'settings-teal': '#07AD9F',   /* web/desktop icon background */
        'settings-help-blue': '#4BA0FE', /* help info icon background */
        'settings-green': '#4BD763',  /* chats WhatsApp icon background */
        'settings-data-green': '#25D366', /* data & storage arrows icon background */

        /* --- Additional Figma-verified colors --- */
        'read-blue': '#3497F9',       /* read receipt double-check blue — Figma fill_LTKHBX */
        'date-separator-bg': '#DDDDE9', /* date pill background — Figma fill_GK81ZU */
        'date-separator-text': '#3C3C43', /* date pill text — Figma fill_FLRUXP */
        'file-bg': 'rgba(118, 118, 128, 0.12)', /* file attachment card bg — Figma fill_8R37EY */
        'overlay-dark': 'rgba(0, 0, 0, 0.4)', /* dimmed overlay/shadow — Figma fill_ZLT6IO */
        'timestamp': 'rgba(0, 0, 0, 0.25)', /* message timestamp text — Figma fill_3UP8CL */
        'file-name': 'rgba(0, 0, 0, 0.7)', /* file name text in messages — Figma fill_RWT8JT */
      },

      /* ============================================================
       * FONT FAMILY — SF Pro Text with system fallback stack
       *
       * Gap Resolution (Section 0.6.4): SF Pro Text is the iOS system
       * font used in all Figma screens. Fallback stack ensures visual
       * consistency across platforms.
       * ============================================================ */
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          "'SF Pro Text'",
          "'Segoe UI'",
          'system-ui',
          'sans-serif',
        ],
      },

      /* ============================================================
       * FONT SIZE — Figma typography specs (Section 0.5.2)
       *
       * Each entry bundles font-size, line-height, and font-weight
       * matching exact Figma text style definitions. Tailwind generates
       * utility classes like `text-nav-title` that apply all three.
       * ============================================================ */
      fontSize: {
        /* text-nav-title: SF Pro Text 600 17px / 1.29em — navigation bar titles */
        'nav-title': ['17px', { lineHeight: '1.29em', fontWeight: '600' }],
        /* text-nav-action: SF Pro Text 400 17px / 1.29em — navigation bar actions ("Edit", "Done") */
        'nav-action': ['17px', { lineHeight: '1.29em', fontWeight: '400' }],
        /* text-chat-name: SF Pro Text 600 16px / 1.31em — chat list contact names, bold labels */
        'chat-name': ['16px', { lineHeight: '1.31em', fontWeight: '600' }],
        /* text-chat-preview: SF Pro Text 400 14px / 1.19em — message previews in chat list */
        'chat-preview': ['14px', { lineHeight: '1.19em', fontWeight: '400' }],
        /* text-chat-date: SF Pro Text 400 14px / 1.19em — timestamps in chat list */
        'chat-date': ['14px', { lineHeight: '1.19em', fontWeight: '400' }],
        /* text-body: SF Pro Text 400 15px / 1.33em — body text, instructions, descriptions */
        'body-text': ['15px', { lineHeight: '1.33em', fontWeight: '400' }],
        /* text-section-header: SF Pro Text 400 13px / 1.23em — section headers, secondary labels */
        'section-header': ['13px', { lineHeight: '1.23em', fontWeight: '400' }],
      },

      /* ============================================================
       * LETTER SPACING — Figma negative tracking conversion
       *
       * Gap Resolution (Section 0.6.4): SF Pro Text uses percentage-based
       * negative tracking. Converted to em for Tailwind compatibility.
       * Conversion: divide percentage by 100 (e.g. -2.35% / 100 = -0.0235em ≈ -0.024em).
       * ============================================================ */
      letterSpacing: {
        'tight-ios': '-0.024em',      /* primary SF Pro Text tracking (-2.35% / 100 ≈ -0.024em) */
        'tighter-ios': '-0.019em',    /* secondary tracking (-1.875% / 100 ≈ -0.019em) for 16px text */
      },

      /* ============================================================
       * BOX SHADOW — Figma shadow definitions (Section 0.5.2)
       *
       * Ultra-thin 0.33px shadows matching iOS HIG hairline separators.
       * ============================================================ */
      boxShadow: {
        /* shadow-nav-bottom: navigation bar bottom edge separator */
        'nav-bottom': '0px 0.33px 0px rgba(166, 166, 170, 1)',
        /* shadow-tab-top: tab bar top edge separator */
        'tab': '0px -0.33px 0px rgba(166, 166, 170, 1)',
        /* shadow-card: form cards and content sections */
        'card': '0px 0.33px 0px rgba(60, 60, 67, 0.29)',
        /* shadow-card-top: top edge shadow for inline form sections */
        'card-top': '0px -0.33px 0px rgba(60, 60, 67, 0.29)',
      },

      /* ============================================================
       * BORDER WIDTH — ultra-thin iOS separators
       *
       * Gap Resolution (Section 0.6.4): Tailwind's minimum border is 1px.
       * Custom 0.33px value via arbitrary property enables iOS-style
       * hairline separators matching Figma specification exactly.
       * ============================================================ */
      borderWidth: {
        'hairline': '0.33px',         /* iOS-style ultra-thin separator line */
      },

      /* ============================================================
       * SPACING — extended scale for specific Figma dimensions
       *
       * Supplements Tailwind's default 4px-based scale with values
       * required by the Figma component specifications.
       * ============================================================ */
      spacing: {
        '4.5': '18px',               /* 18px — various Figma element gaps */
        '13': '52px',                 /* 52px — standard avatar diameter (medium) */
        '15': '60px',                 /* 60px — large spacing, section padding */
        '18': '72px',                 /* 72px — extra-large element spacing */
        '18.5': '74px',              /* 74px — chat list item row height */
        '22': '88px',                 /* 88px — navigation header total height (status bar + nav bar) */
      },

      /* ============================================================
       * WIDTH — specific fixed-dimension tokens
       * ============================================================ */
      width: {
        'toggle': '51px',             /* iOS toggle switch width */
      },

      /* ============================================================
       * HEIGHT — iOS UI chrome and component dimensions
       *
       * These fixed heights match the exact Figma specifications for
       * iOS system chrome elements and key UI components.
       * ============================================================ */
      height: {
        'toggle': '31px',             /* iOS toggle switch height */
        'status-bar': '44px',         /* iOS status bar (iPhone X notch area) */
        'home-indicator': '34px',     /* iOS home indicator gesture bar area */
        'tab-bar': '83px',            /* tab bar: 49px content + 34px safe area inset */
        'nav-bar': '44px',            /* navigation bar content height */
        'chat-row': '74px',           /* chat list item row height */
      },

      /* ============================================================
       * SCREENS — Responsive breakpoints (Rule R3)
       *
       * Mobile-first approach from 375px base Figma frame.
       * Three breakpoints scale the single-frame 375px design:
       * - tablet (768px): collapsible sidebar layout
       * - desktop (1280px): side-by-side panels
       * - wide (1440px): Figma fidelity measurement target (≤5% pixel diff)
       * ============================================================ */
      screens: {
        'mobile': '375px',            /* Mobile base (Figma artboard width) */
        'tablet': '768px',            /* Tablet — collapsible sidebar */
        'desktop': '1280px',          /* Desktop — side-by-side conversation panels */
        'wide': '1440px',             /* Wide desktop — Figma fidelity target viewport */
      },
    },
  },
  plugins: [],
};

export default config;
