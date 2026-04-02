'use client';

import React, { useEffect, useRef, useCallback } from 'react';

/* ====================================================================== */
/* Exported interfaces                                                     */
/* ====================================================================== */

/** Represents a single action item within the ActionSheet */
export interface ActionSheetItem {
  /** Display label for the action */
  label: string;
  /** Optional icon rendered to the left of the label */
  icon?: React.ReactNode;
  /** Handler invoked when this action is selected */
  onPress: () => void;
  /** When true, renders the label in destructive red (#FF3B30) */
  destructive?: boolean;
}

/** Props for the ActionSheet component */
export interface ActionSheetProps {
  /** Controls visibility of the action sheet */
  isOpen: boolean;
  /** Called when the sheet should close (backdrop tap, cancel, or Escape key) */
  onClose: () => void;
  /** Array of action items to display in the actions card */
  items: ActionSheetItem[];
  /** Label for the cancel button. Defaults to "Cancel" */
  cancelLabel?: string;
  /** Optional additional CSS class name for the sheet container */
  className?: string;
}

/* ====================================================================== */
/* CSS keyframes for slide-up and fade-in animations                       */
/* No custom animation keyframes exist in tailwind.config.ts — injected   */
/* as a scoped <style> block within the component.                         */
/* Wrapped in prefers-reduced-motion for WCAG 2.1 AA compliance (R34).    */
/* ====================================================================== */
const ACTION_SHEET_KEYFRAMES = `
@media(prefers-reduced-motion:no-preference){
@keyframes action-sheet-fade-in{from{opacity:0}to{opacity:1}}
@keyframes action-sheet-slide-up{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
}`;

/**
 * iOS-style bottom action sheet modal overlay.
 *
 * Matches Figma node 0:10283 from file miK1B6qEPrUnRZ9wwZNrW2.
 * Used on: Chat Actions (0:10087), Attachment Modal (0:9072), Settings Modal (0:9778).
 *
 * Structure:
 * - Full-screen semi-transparent backdrop: rgba(0,0,0,0.4)
 * - Actions card: rounded-[15px], bg-[#ECECED], white action item buttons (57px tall)
 * - Cancel card: rounded-[14px], bg-white, semibold cancel text — separated by ~8px gap
 *
 * Accessibility (WCAG 2.1 AA — R34):
 * - role="dialog", aria-modal="true", aria-label="Action sheet"
 * - Focus trapped within the sheet (Tab / Shift+Tab cycles through buttons)
 * - Escape key dismisses the sheet
 * - Body scroll locked while the sheet is open
 * - Focus saved on open and restored to the trigger element on close
 */
export const ActionSheet: React.FC<ActionSheetProps> = ({
  isOpen,
  onClose,
  items,
  cancelLabel = 'Cancel',
  className = '',
}) => {
  /** Reference to the dialog container for querying focusable elements */
  const sheetRef = useRef<HTMLDivElement>(null);

  /** Stores the element that had focus before the sheet opened */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /* ------------------------------------------------------------------ */
  /* Focus management and body scroll lock                               */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (isOpen) {
      /* Save the element that had focus before the sheet opened */
      previousFocusRef.current = document.activeElement as HTMLElement;

      /* Focus the first action button after the DOM paints */
      requestAnimationFrame(() => {
        const firstButton =
          sheetRef.current?.querySelector<HTMLButtonElement>('button');
        firstButton?.focus();
      });

      /* Lock body scroll while the sheet is open */
      document.body.style.overflow = 'hidden';
    } else {
      /* Unlock body scroll */
      document.body.style.overflow = '';

      /* Restore focus to the element that triggered the sheet */
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  /* ------------------------------------------------------------------ */
  /* Global Escape key handler                                           */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isOpen, onClose]);

  /* ------------------------------------------------------------------ */
  /* Focus trap — cycles Tab / Shift+Tab through all buttons in sheet    */
  /* ------------------------------------------------------------------ */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab') return;

      const focusableElements =
        sheetRef.current?.querySelectorAll<HTMLButtonElement>('button');

      if (!focusableElements || focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    },
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Render nothing when the sheet is closed                             */
  /* ------------------------------------------------------------------ */
  if (!isOpen) return null;

  return (
    <>
      {/* Scoped animation keyframes (wrapped in prefers-reduced-motion) */}
      <style>{ACTION_SHEET_KEYFRAMES}</style>

      {/* Full-screen overlay — clicking the backdrop dismisses the sheet */}
      <div
        className="fixed inset-0 z-50 flex flex-col justify-end"
        onClick={onClose}
        role="presentation"
      >
        {/* Backdrop — semi-transparent black overlay per Figma: rgba(0,0,0,0.4) */}
        <div
          className="absolute inset-0 bg-overlay-dark"
          aria-hidden="true"
          style={{
            animation: 'action-sheet-fade-in 200ms ease-out forwards',
          }}
        />

        {/* Sheet container — positioned at bottom with 10px horizontal margins */}
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label="Action sheet"
          className={`relative mx-[10px] mb-[10px] ${className}`.trim()}
          style={{
            animation:
              'action-sheet-slide-up 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          {/* -------------------------------------------------------------- */}
          {/* Actions card                                                    */}
          {/* Figma node 0:10287: 355px wide, bg #ECECED, borderRadius 15px  */}
          {/* Items: 57px tall white buttons with 0.33px #C6C6C8 separators  */}
          {/* -------------------------------------------------------------- */}
          {/* BLITZY [DESIGN_SYSTEM_GAP]: Figma #ECECED (action sheet card bg) has no Tailwind token. Used arbitrary value. */}
          <div className="overflow-hidden rounded-[15px] bg-[#ECECED]">
            {items.map((item, idx) => (
              <React.Fragment key={idx}>
                {/* Action item button */}
                <button
                  type="button"
                  onClick={() => {
                    item.onPress();
                    onClose();
                  }}
                  className={[
                    'flex w-full items-center justify-center',
                    'h-[57px] bg-white',
                    /* Figma: SF Pro Display 400, 20px, lineHeight 1.193em, tracking 1.65% */
                    'text-[20px] font-normal leading-[1.193em] tracking-[0.0165em]',
                    'font-sans',
                    item.destructive ? 'text-red-ios' : 'text-blue-ios',
                    /* Interactive states */
                    'active:bg-gray-100',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1',
                  ].join(' ')}
                >
                  {item.icon != null && (
                    <span
                      className="mr-3 flex items-center"
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                  )}
                  {item.label}
                </button>

                {/* Separator between items: 0.33px in #C6C6C8 */}
                {/* NOTE: This color is specific to action sheets — NOT the standard */}
                {/*        separator token rgba(60,60,67,0.29)                       */}
                {/* BLITZY [DESIGN_SYSTEM_GAP]: Figma #C6C6C8 (action sheet separator) differs from standard separator token. Used arbitrary value. */}
                {idx < items.length - 1 && (
                  <div
                    className="h-[0.33px] w-full bg-[#C6C6C8]"
                    role="separator"
                    aria-hidden="true"
                  />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* -------------------------------------------------------------- */}
          {/* Cancel button — separate card below with ~8px gap (mt-2)       */}
          {/* Figma node 0:10284: 355px × 57px, bg white, borderRadius 14px */}
          {/* Text: SF Pro Text 600, 19px, lineHeight 1.263em,               */}
          {/*        letterSpacing -2.37% ≈ -0.045em, color #007AFF          */}
          {/* -------------------------------------------------------------- */}
          <button
            type="button"
            onClick={onClose}
            className={[
              'mt-2 flex w-full items-center justify-center',
              'h-[57px] rounded-[14px] bg-white',
              'text-[19px] font-semibold leading-[1.263em] tracking-[-0.045em]',
              'font-sans text-blue-ios',
              'active:bg-gray-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1',
            ].join(' ')}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </>
  );
};

export default ActionSheet;
