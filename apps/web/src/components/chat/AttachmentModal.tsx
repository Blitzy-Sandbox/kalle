'use client';

import React, { FC, ReactNode, useMemo } from 'react';
import Image from 'next/image';
import ActionSheet, { ActionSheetItem } from '@/components/common/ActionSheet';

/* ====================================================================== */
/* SVG icon imports — Figma node 0:9072 (WhatsApp Add Modal)              */
/* Each icon is blue #007AFF, baked into the SVG fill attribute.           */
/* ====================================================================== */
import iconCameraAction from '@/assets/icons/icon-camera-action.svg';
import iconPhotoLibrary from '@/assets/icons/icon-photo-library.svg';
import iconDocumentAction from '@/assets/icons/icon-document-action.svg';
import iconLocation from '@/assets/icons/icon-location.svg';
import iconContact from '@/assets/icons/icon-contact.svg';

/* ====================================================================== */
/* Exported interfaces                                                     */
/* ====================================================================== */

/**
 * Props for the AttachmentModal component.
 *
 * Controls the iOS-style action sheet triggered from the "+" attachment
 * button in the message input bar. Presents 5 media/content attachment
 * options: Camera, Photo & Video Library, Document, Location, Contact.
 */
export interface AttachmentModalProps {
  /** Whether the action sheet is visible */
  isOpen: boolean;
  /** Callback to close/dismiss the action sheet */
  onClose: () => void;
  /** Open device camera for photo/video capture */
  onCamera: () => void;
  /** Open photo and video library picker */
  onPhotoLibrary: () => void;
  /** Open document file picker */
  onDocument: () => void;
  /** Open location sharing interface */
  onLocation: () => void;
  /** Open contact sharing interface */
  onContact: () => void;
}

/* ====================================================================== */
/* Icon wrapper component                                                  */
/* ====================================================================== */

/**
 * Fixed-width icon container ensuring consistent label positioning at x=64.
 *
 * Layout calculation (per Figma node 0:9075):
 * - Button padding-inline-start: 20px (ps-5)
 * - Icon container width: 32px (w-8) — centers variable-width icons
 * - ActionSheet icon span margin-right: 12px (mr-3, from ActionSheet)
 * - Total offset: 20 + 32 + 12 = 64px → label starts at x=64 ✓
 *
 * The container uses flex centering so icons of varying widths
 * (17–24px) are visually centered within the same 32px column.
 */
function AttachmentIcon({
  src,
  width,
  height,
}: {
  /** Static SVG import from assets/icons/ */
  src: typeof iconCameraAction;
  /** Intrinsic SVG width in px (prevents layout shift) */
  width: number;
  /** Intrinsic SVG height in px (prevents layout shift) */
  height: number;
}): ReactNode {
  return (
    <span className="flex w-8 items-center justify-center">
      <Image
        src={src}
        alt=""
        width={width}
        height={height}
        aria-hidden="true"
      />
    </span>
  );
}

/* ====================================================================== */
/* Tailwind overrides for ActionSheet action buttons                        */
/*                                                                         */
/* The ActionSheet base component renders items center-aligned with blue    */
/* text (for ChatActionsModal). AttachmentModal requires:                   */
/*   - LEFT-aligned text at x=64 (not centered)                            */
/*   - BLACK text #000000 (not blue #007AFF)                               */
/*   - Letter-spacing 1.75% (not 1.65%)                                    */
/*   - Left padding 20px for icon positioning                              */
/*                                                                         */
/* Selector: [&>div:first-child>button] targets action card buttons        */
/* without affecting the cancel button (which is a sibling, not a child    */
/* of the actions card div).                                               */
/*                                                                         */
/* Specificity: Parent variant selectors (0,2,2) override the button's    */
/* own utility classes (0,1,0) — no !important needed.                     */
/* ====================================================================== */
const ACTION_BUTTON_OVERRIDES = [
  /* Override center alignment → left alignment (Figma: items start at x=20 with icons) */
  '[&>div:first-child>button]:justify-start',
  /* Padding-inline-start: 20px — positions icon at x=20 from button edge */
  '[&>div:first-child>button]:ps-5',
  /* Text color: #000000 black (AttachmentModal) instead of #007AFF blue (ChatActionsModal) */
  '[&>div:first-child>button]:text-black',
  /* Letter-spacing: 1.75% ≈ 0.0175em (Figma spec, vs 1.65% for ChatActionsModal) */
  '[&>div:first-child>button]:tracking-[0.0175em]',
].join(' ');

/* ====================================================================== */
/* AttachmentModal component                                               */
/* ====================================================================== */

/**
 * AttachmentModal — iOS-style attachment picker action sheet.
 *
 * Maps to Figma screen 5, node 0:9072 (WhatsApp Add Modal),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Renders 5 action items with blue icons and black labels via the
 * shared ActionSheet component:
 *   1. Camera (22×20 icon)
 *   2. Photo & Video Library (24×20 icon)
 *   3. Document (17×23 icon)
 *   4. Location (19×26 icon)
 *   5. Contact (24×24 icon)
 *
 * CRITICAL DIFFERENCES FROM ChatActionsModal:
 * | Property        | ChatActionsModal   | AttachmentModal              |
 * |-----------------|--------------------|------------------------------|
 * | Text Alignment  | CENTER             | LEFT (x=64, after icon)      |
 * | Text Color      | #007AFF (blue)     | #000000 (black)              |
 * | Icons           | NONE               | YES — blue #007AFF left      |
 * | Letter-spacing  | 1.65%              | 1.75%                        |
 * | Destructive     | "Delete Chat" red  | NONE                         |
 *
 * Accessibility (inherits from ActionSheet — WCAG 2.1 AA R34):
 * - role="dialog", aria-modal="true", aria-label="Action sheet"
 * - Focus trapped within the sheet (Tab / Shift+Tab cycles through buttons)
 * - Escape key dismisses the sheet
 * - Body scroll locked while the sheet is open
 * - Icons are decorative (aria-hidden="true" on icon spans)
 */
const AttachmentModal: FC<AttachmentModalProps> = ({
  isOpen,
  onClose,
  onCamera,
  onPhotoLibrary,
  onDocument,
  onLocation,
  onContact,
}) => {
  /**
   * Memoized action items array. Rebuilds only when callback references
   * change, preventing unnecessary ActionSheet re-renders.
   *
   * Each item matches Figma node 0:9075 specifications:
   * - icon: Blue #007AFF SVG in fixed-width container (32px)
   * - label: Black #000000 text, left-aligned at x=64
   * - onPress: Callback (ActionSheet auto-calls onClose after onPress)
   */
  const items: ActionSheetItem[] = useMemo(
    () => [
      {
        label: 'Camera',
        icon: (
          <AttachmentIcon src={iconCameraAction} width={22} height={20} />
        ),
        onPress: onCamera,
      },
      {
        label: 'Photo & Video Library',
        icon: (
          <AttachmentIcon src={iconPhotoLibrary} width={24} height={20} />
        ),
        onPress: onPhotoLibrary,
      },
      {
        label: 'Document',
        icon: (
          <AttachmentIcon src={iconDocumentAction} width={17} height={23} />
        ),
        onPress: onDocument,
      },
      {
        label: 'Location',
        icon: <AttachmentIcon src={iconLocation} width={19} height={26} />,
        onPress: onLocation,
      },
      {
        label: 'Contact',
        icon: <AttachmentIcon src={iconContact} width={24} height={24} />,
        onPress: onContact,
      },
    ],
    [onCamera, onPhotoLibrary, onDocument, onLocation, onContact],
  );

  return (
    <ActionSheet
      isOpen={isOpen}
      onClose={onClose}
      items={items}
      cancelLabel="Cancel"
      className={ACTION_BUTTON_OVERRIDES}
    />
  );
};

export default AttachmentModal;
