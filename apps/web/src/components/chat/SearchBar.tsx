'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Props for the SearchBar component.
 *
 * @property placeholder - Placeholder text shown when input is empty. Default: "Search"
 * @property value - Controlled input value from parent store (e.g., uiStore.searchQuery)
 * @property onChange - Callback fired after 300ms debounce with the new search term.
 *   Rule R21: This callback triggers client-side IndexedDB search only — zero network calls.
 * @property onClear - Callback fired when the clear button (×) is clicked or Escape is pressed
 * @property onFocus - Optional callback fired when the input gains focus
 * @property onBlur - Optional callback fired when the input loses focus
 * @property autoFocus - Whether the input should auto-focus on mount. Default: false
 */
export interface SearchBarProps {
  /** Placeholder text. Default: "Search" */
  placeholder?: string;
  /** Controlled search value from parent */
  value: string;
  /** Debounced change handler — R21: client-side only, zero network calls */
  onChange: (value: string) => void;
  /** Called when user clears search (× button or Escape key) */
  onClear: () => void;
  /** Optional focus handler */
  onFocus?: () => void;
  /** Optional blur handler */
  onBlur?: () => void;
  /** Auto-focus on mount */
  autoFocus?: boolean;
}

/**
 * iOS-style search bar for client-side message search.
 *
 * Renders a rounded-rectangle search input with a magnifying glass icon on the
 * left and a circular clear button (×) on the right when text is present.
 * Implements 300ms input debounce to avoid excessive IndexedDB queries.
 *
 * Design Specs (iOS search bar pattern — no direct Figma node):
 * - Background: rgba(118, 118, 128, 0.12) → Tailwind `bg-file-bg`
 * - Height: 36px, border-radius: 10px
 * - Search icon: 14×14px, #8E8E93 (inline SVG magnifying glass)
 * - Clear button: 16×16px circular, #8E8E93 fill with white × glyph
 * - Typography: 16px / 1.193em, font-weight 400, font-sans (SF Pro Text)
 * - Placeholder color: #8E8E93 (secondary)
 * - Input text color: #000000 (primary)
 *
 * Behavior (Rule R21 — Client-Side Search Only):
 * - Search operates EXCLUSIVELY against client-side IndexedDB
 * - Zero search-related API/network calls during search
 * - 300ms debounce before triggering onChange callback
 * - Escape key clears the input and blurs the element
 *
 * Accessibility:
 * - role="searchbox" on the input element
 * - aria-label="Search messages" for screen readers
 * - Clear button: aria-label="Clear search"
 * - Visible :focus-visible ring using blue-ios (#007AFF)
 *
 * BLITZY [COLOR]: Placeholder #8E8E93 (3.26:1 on white) is below 4.5:1 text
 * threshold but exempt per WCAG 2.1 SC 1.4.3 (inactive UI component). Standard
 * iOS system color from Figma spec. Input text #000000 passes at 21:1.
 * Icons #8E8E93 pass 3:1 UI component threshold (SC 1.4.11).
 *
 * @example
 * ```tsx
 * const [query, setQuery] = useState('');
 * <SearchBar
 *   value={query}
 *   onChange={setQuery}
 *   onClear={() => setQuery('')}
 *   placeholder="Search messages"
 * />
 * ```
 */
const SearchBar: React.FC<SearchBarProps> = ({
  placeholder = 'Search',
  value,
  onChange,
  onClear,
  onFocus,
  onBlur,
  autoFocus = false,
}) => {
  /**
   * Internal display value tracks what the user types in real time.
   * The parent `value` prop is the source of truth for the *committed*
   * (debounced) search string. We sync the display value with the
   * external `value` prop via useEffect so that external resets
   * (e.g., onClear from parent) propagate to the input.
   */
  const [displayValue, setDisplayValue] = useState<string>(value);

  /** Ref to the debounce timer so we can clear it on unmount or re-type */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Ref to the native <input> element for programmatic focus/blur */
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Sync internal display value when the external controlled value changes.
   * This handles the case where a parent component resets the value
   * (e.g., calling onClear sets value to '').
   */
  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  /**
   * Cleanup the debounce timer on unmount to prevent memory leaks
   * and stale callback invocations after the component is destroyed.
   */
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  /**
   * Handle input changes with 300ms debounce.
   *
   * Updates the display value immediately for responsive typing,
   * but delays the onChange callback by 300ms. Each new keystroke
   * resets the timer so only the final value triggers a search.
   *
   * Rule R21: The onChange callback must invoke client-side IndexedDB
   * search only — never a network request.
   */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setDisplayValue(newValue);

      /* Clear any pending debounce timer from previous keystroke */
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }

      /* Schedule the debounced onChange callback after 300ms */
      debounceTimerRef.current = setTimeout(() => {
        onChange(newValue);
        debounceTimerRef.current = null;
      }, 300);
    },
    [onChange],
  );

  /**
   * Handle clear action: reset display and committed values,
   * cancel any pending debounce, and re-focus the input.
   */
  const handleClear = useCallback(() => {
    setDisplayValue('');

    /* Cancel pending debounce to prevent stale callback */
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    onClear();

    /* Return focus to the input after clearing */
    inputRef.current?.focus();
  }, [onClear]);

  /**
   * Handle keyboard events:
   * - Escape: clear input content and blur the element
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDisplayValue('');

        /* Cancel pending debounce */
        if (debounceTimerRef.current !== null) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }

        onClear();
        inputRef.current?.blur();
      }
    },
    [onClear],
  );

  /** Whether the clear button should be visible (only when text is present) */
  const showClear = displayValue.length > 0;

  return (
    <div
      className={[
        /* Container: full width with 16px horizontal padding */
        'w-full',
        'px-4',
      ].join(' ')}
    >
      <div
        className={[
          /* Search bar: rounded rectangle with iOS search bar background */
          'relative',
          'flex',
          'items-center',
          'w-full',
          'h-9',                                /* 36px */
          'rounded-[10px]',
          'bg-file-bg',                         /* rgba(118, 118, 128, 0.12) */
        ].join(' ')}
      >
        {/* Magnifying glass search icon — 14×14px, positioned 8px from left */}
        <div
          className="flex-shrink-0 ps-2"        /* padding-inline-start: 8px */
          aria-hidden="true"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-secondary"
          >
            <path
              d="M5.91667 1.16667C7.17734 1.16667 8.38647 1.66726 9.27602 2.55682C10.1656 3.44637 10.6662 4.6555 10.6662 5.91617C10.6662 7.08484 10.2395 8.16117 9.53617 8.99617L9.71617 9.17617H10.2082L13.0415 12.0095L12.0095 13.0415L9.17617 10.2082V9.71617L8.99617 9.53617C8.16117 10.2395 7.08484 10.6662 5.91667 10.6662C4.65601 10.6662 3.44687 10.1656 2.55732 9.27602C1.66776 8.38647 1.16717 7.17734 1.16717 5.91667C1.16717 4.65601 1.66776 3.44687 2.55732 2.55732C3.44687 1.66776 4.65601 1.16667 5.91667 1.16667ZM5.91667 2.33333C4.08333 2.33333 2.58333 3.83333 2.58333 5.66667C2.58333 7.5 4.08333 9 5.91667 9C7.75 9 9.25 7.5 9.25 5.66667C9.25 3.83333 7.75 2.33333 5.91667 2.33333Z"
              fill="currentColor"
            />
          </svg>
        </div>

        {/* Search input field */}
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label="Search messages"
          placeholder={placeholder}
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          autoFocus={autoFocus}
          className={[
            /* Fill remaining space */
            'flex-1',
            'min-w-0',
            /* Remove native input styling */
            'bg-transparent',
            'border-none',
            'outline-none',
            /* Typography: 16px / 1.193em, regular weight, SF Pro Text */
            'text-[16px]',
            'leading-[1.193em]',
            'font-normal',
            'font-sans',
            /* Text colors */
            'text-black',
            'placeholder:text-secondary',
            /* Padding: 8px inline for balanced spacing */
            'ps-2',
            'pe-2',
            /* Focus ring — only on keyboard navigation */
            'focus-visible:ring-2',
            'focus-visible:ring-blue-ios',
            'focus-visible:rounded-[10px]',
            'focus:outline-none',
          ].join(' ')}
        />

        {/* Clear button (×) — visible only when input has text */}
        {showClear && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className={[
              /* Circular clear button: 16×16px */
              'flex-shrink-0',
              'flex',
              'items-center',
              'justify-center',
              'w-4',                             /* 16px */
              'h-4',                             /* 16px */
              'rounded-full',
              'bg-secondary',                    /* #8E8E93 circle */
              /* Positioned 8px from right edge */
              'me-2',                            /* margin-inline-end: 8px */
              /* Interaction styles */
              'cursor-pointer',
              'border-none',
              'p-0',
              /* Focus ring for keyboard users */
              'focus-visible:ring-2',
              'focus-visible:ring-blue-ios',
              'focus-visible:ring-offset-1',
              'focus:outline-none',
            ].join(' ')}
          >
            {/* White × glyph inside the circle */}
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M1 1L7 7M7 1L1 7"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

export default SearchBar;
