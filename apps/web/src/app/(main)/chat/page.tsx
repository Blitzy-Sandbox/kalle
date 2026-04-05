'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import ChatList from '@/components/chat/ChatList';
import type { ConversationListItem } from '@kalle/shared';
import { useChatStore } from '@/stores/chatStore';

/**
 * Chat Page — renders the ChatList component for the /chat route.
 * Includes mock data injection for visual testing.
 */
export default function ChatPage() {
  const router = useRouter();
  const setConversations = useChatStore((s) => s.setConversations);
  const setIsLoading = useChatStore((s) => s.setIsLoadingConversations);
  const conversations = useChatStore((s) => s.conversations);

  useEffect(() => {
    if (conversations.length > 0) return;
    const now = Date.now();
    /* ConversationListItem[] matching packages/shared/src/types/conversation.ts */
    const mockConversations = [
      {
        id: 'conv-1', type: 'DIRECT' as const, displayName: 'Martin Randolph',
        lastMessage: { senderName: 'Test User', ciphertext: 'You: What time works best for the meeting tomorrow?', type: 'TEXT', serverTimestamp: new Date(now - 60000 * 5).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-2', type: 'DIRECT' as const, displayName: 'Andrew Parker',
        lastMessage: { senderName: 'Test User', ciphertext: 'You: How about tomorrow then? I was thinking noon', type: 'TEXT', serverTimestamp: new Date(now - 60000 * 30).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-3', type: 'DIRECT' as const, displayName: 'Karen Castillo',
        lastMessage: { senderName: 'Karen Castillo', ciphertext: '0:14', type: 'VOICE_NOTE', serverTimestamp: new Date(now - 60000 * 60).toISOString(), isDeleted: false },
        unreadCount: 2, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-4', type: 'DIRECT' as const, displayName: 'Maximillian Jacobson',
        lastMessage: { senderName: 'Test User', ciphertext: 'You: Let me know if you need anything else', type: 'TEXT', serverTimestamp: new Date(now - 60000 * 120).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-5', type: 'DIRECT' as const, displayName: 'Martha Craig',
        lastMessage: { senderName: 'Martha Craig', ciphertext: 'Photo', type: 'IMAGE', serverTimestamp: new Date(now - 60000 * 180).toISOString(), isDeleted: false },
        unreadCount: 1, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-6', type: 'DIRECT' as const, displayName: 'Tabitha Potter',
        lastMessage: { senderName: 'Tabitha Potter', ciphertext: 'Hey! Just wanted to reach out and see how the project is going.', type: 'TEXT', serverTimestamp: new Date(now - 86400000).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-7', type: 'DIRECT' as const, displayName: 'Maisy Humphrey',
        lastMessage: { senderName: 'Test User', ciphertext: 'You: Welcome, to make design process faster, look at Pixsellz', type: 'TEXT', serverTimestamp: new Date(now - 86400000 * 2).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
      {
        id: 'conv-8', type: 'DIRECT' as const, displayName: 'Kieron Dotson',
        lastMessage: { senderName: 'Test User', ciphertext: 'You: Thanks for the update!', type: 'TEXT', serverTimestamp: new Date(now - 86400000 * 3).toISOString(), isDeleted: false },
        unreadCount: 0, isArchived: false, isMuted: false,
      },
    ];
    setIsLoading(false);
    setConversations(mockConversations as ConversationListItem[]);
  }, [conversations.length, setConversations, setIsLoading]);

  const handleSelectConversation = useCallback(
    (id: string) => router.push(`/chat/${id}`),
    [router],
  );
  const handleNewChat = useCallback(() => {}, []);
  const handleBroadcastLists = useCallback(() => {}, []);
  const handleNewGroup = useCallback(() => {}, []);

  return (
    <ChatList
      onSelectConversation={handleSelectConversation}
      onNewChat={handleNewChat}
      onBroadcastLists={handleBroadcastLists}
      onNewGroup={handleNewGroup}
    />
  );
}
