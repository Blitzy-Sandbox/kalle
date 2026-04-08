'use client';

import React, { FC, useMemo } from 'react';
import ActionSheet, { ActionSheetItem } from '@/components/common/ActionSheet';

/**
 * Props for the ChatActionsModal component.
 *
 * Controls the iOS-style action sheet overlay triggered from
 * the "More" swipe action on a chat list item (Figma screen 3,
 * node 0:10087 — WhatsApp Chat Actions).
 */
export interface ChatActionsModalProps {
  /** Whether the action sheet is visible */
  isOpen: boolean;
  /** Callback to close/dismiss the action sheet */
  onClose: () => void;
  /** ID of the conversation this action sheet targets */
  conversationId: string;
  /** Display name of the contact for this conversation */
  contactName: string;
  /** Whether the conversation is currently muted — toggles label between "Mute" and "Unmute" */
  isMuted: boolean;
  /** Toggle mute/unmute for the conversation */
  onMute: () => void;
  /** Navigate to contact info page */
  onContactInfo: () => void;
  /** Export the conversation data */
  onExportChat: () => void;
  /** Clear all messages in the conversation */
  onClearChat: () => void;
  /** Delete the entire conversation (destructive action) */
  onDeleteChat: () => void;
}

/**
 * ChatActionsModal — iOS-style action sheet for chat-level operations.
 *
 * Renders 5 action items via the shared ActionSheet component:
 *   1. Mute / Unmute (toggles based on `isMuted`)
 *   2. Contact Info
 *   3. Export Chat
 *   4. Clear Chat
 *   5. Delete Chat (destructive — displayed in red #FF3B30)
 *
 * Design Notes (Figma node 0:10087, file key miK1B6qEPrUnRZ9wwZNrW2):
 * - NO icons in this action sheet (text-only, unlike AttachmentModal)
 * - All non-destructive items use blue #007AFF text (handled by ActionSheet)
 * - "Delete Chat" uses red #FF3B30 text (via `destructive: true`)
 * - Text is center-aligned, 20px, letter-spacing 1.65% (handled by ActionSheet)
 * - Cancel button: 19px semibold, letter-spacing -2.37% (handled by ActionSheet)
 *
 * Accessibility:
 * - Focus trap and Escape key dismiss inherited from ActionSheet
 * - Destructive action includes descriptive aria-label for screen readers
 */
const ChatActionsModal: FC<ChatActionsModalProps> = ({
  isOpen,
  onClose,
  /* conversationId and contactName are part of the typed props contract
     for parent component context; the action callbacks (onMute, onDeleteChat, etc.)
     are closures provided by the parent that already reference the target conversation. */
  isMuted,
  onMute,
  onContactInfo,
  onExportChat,
  onClearChat,
  onDeleteChat,
}) => {
  /**
   * Memoized action items array. Rebuilds only when `isMuted` changes,
   * preventing unnecessary ActionSheet re-renders from parent state updates.
   *
   * Each item follows the ActionSheetItem interface:
   *   - label: visible text
   *   - onPress: callback (ActionSheet auto-calls onClose after onPress)
   *   - destructive: optional flag for red text styling
   *
   * Note: No `icon` property is set — this action sheet is text-only per Figma.
   */
  const items: ActionSheetItem[] = useMemo(
    () => [
      {
        label: isMuted ? 'Unmute' : 'Mute',
        onPress: onMute,
      },
      {
        label: 'Contact Info',
        onPress: onContactInfo,
      },
      {
        label: 'Export Chat',
        onPress: onExportChat,
      },
      {
        label: 'Clear Chat',
        onPress: onClearChat,
      },
      {
        label: 'Delete Chat',
        onPress: onDeleteChat,
        destructive: true,
      },
    ],
    [isMuted, onMute, onContactInfo, onExportChat, onClearChat, onDeleteChat],
  );

  return (
    <ActionSheet
      isOpen={isOpen}
      onClose={onClose}
      items={items}
      cancelLabel="Cancel"
    />
  );
};

export default ChatActionsModal;
