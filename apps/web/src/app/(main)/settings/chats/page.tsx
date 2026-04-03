'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import ChatSettings from '@/components/settings/ChatSettings';

/**
 * Chat Settings Page Route — Thin wrapper around the reusable ChatSettings
 * component. All UI logic lives in the component; the page only provides
 * routing callbacks.
 *
 * Corresponds to Figma Screen 18 (WhatsApp Chats Settings, node 0:9973).
 */
export default function ChatsSettingsPage() {
  const router = useRouter();

  return (
    <ChatSettings
      onBack={() => router.back()}
      onChangeWallpaper={() => {
        /* Wallpaper selection — implementation deferred to wallpaper feature */
      }}
      onChatBackup={() => {
        /* Chat backup flow — implementation deferred to backup feature */
      }}
      onArchiveAll={() => {
        /* Archive all chats action */
      }}
      onClearAll={() => {
        /* Clear all chats confirmation flow */
      }}
      onDeleteAll={() => {
        /* Delete all chats confirmation flow */
      }}
    />
  );
}
