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
      onTabPress={(tab) => router.push(`/${tab}`)}
    />
  );
}
