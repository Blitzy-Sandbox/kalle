import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useUIStore } from '@/stores/uiStore';

// ---------------------------------------------------------------------------
// Unit Tests — useUIStore (Zustand UI State Store)
//
// Validates all UI state management: tab navigation, modal management,
// edit mode, mobile stack navigation (R15), search state, toast
// notifications, and full state reset (logout).
// ---------------------------------------------------------------------------

describe('uiStore', () => {
  beforeEach(() => {
    // Use fake timers to control showToast auto-dismiss (3 s setTimeout)
    vi.useFakeTimers();
    useUIStore.getState().resetAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Phase 1: Default / Initial State
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('store initializes with correct default values', () => {
      const state = useUIStore.getState();

      // Tab — Figma Screen 1 default
      expect(state.activeTab).toBe('chats');

      // Modal
      expect(state.activeModal).toBeNull();
      expect(state.modalData).toBeNull();

      // Edit mode
      expect(state.isEditMode).toBe(false);
      expect(state.selectedItems.size).toBe(0);

      // Mobile navigation (R15) — list visible by default
      expect(state.isMobileNavOpen).toBe(true);

      // Search (R21)
      expect(state.searchQuery).toBe('');
      expect(state.isSearchActive).toBe(false);

      // Toast
      expect(state.toastMessage).toBeNull();
      expect(state.toastType).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Tab Navigation
  // -----------------------------------------------------------------------

  describe('setActiveTab', () => {
    it('changes the active tab', () => {
      useUIStore.getState().setActiveTab('status');
      expect(useUIStore.getState().activeTab).toBe('status');

      useUIStore.getState().setActiveTab('calls');
      expect(useUIStore.getState().activeTab).toBe('calls');
    });

    it('supports all 5 tab values matching Figma TabBar', () => {
      const tabs = ['status', 'calls', 'camera', 'chats', 'settings'] as const;

      for (const tab of tabs) {
        useUIStore.getState().setActiveTab(tab);
        expect(useUIStore.getState().activeTab).toBe(tab);
      }
    });

    it('resets modal, edit mode, and search on tab switch', () => {
      // Set up non-default state across all UI areas
      const s = useUIStore.getState();
      s.openModal('chatActions', { id: '1' });
      s.toggleEditMode();
      s.setSearchActive(true);
      s.setSearchQuery('query');

      // Switch tab
      useUIStore.getState().setActiveTab('settings');

      const after = useUIStore.getState();
      expect(after.activeModal).toBeNull();
      expect(after.modalData).toBeNull();
      expect(after.isEditMode).toBe(false);
      expect(after.selectedItems.size).toBe(0);
      expect(after.isSearchActive).toBe(false);
      expect(after.searchQuery).toBe('');
    });

    it('resets mobile navigation state on tab switch', () => {
      useUIStore.getState().pushMobileNav('/chat/123');
      expect(useUIStore.getState().isMobileNavOpen).toBe(false);

      useUIStore.getState().setActiveTab('settings');
      expect(useUIStore.getState().isMobileNavOpen).toBe(true);
    });

    it('does not crash when setting the same tab', () => {
      useUIStore.getState().setActiveTab('chats');
      expect(useUIStore.getState().activeTab).toBe('chats');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: Modal Management
  // -----------------------------------------------------------------------

  describe('openModal / closeModal', () => {
    it('openModal sets activeModal and modalData', () => {
      useUIStore.getState().openModal('chatActions', {
        conversationId: 'conv-1',
        conversationName: 'Martha Craig',
      });

      const state = useUIStore.getState();
      expect(state.activeModal).toBe('chatActions');
      expect(state.modalData).toEqual({
        conversationId: 'conv-1',
        conversationName: 'Martha Craig',
      });
    });

    it('openModal with no data sets modalData to null', () => {
      useUIStore.getState().openModal('attachment');

      const state = useUIStore.getState();
      expect(state.activeModal).toBe('attachment');
      expect(state.modalData).toBeNull();
    });

    it('openModal replaces existing modal (only one modal at a time)', () => {
      useUIStore.getState().openModal('chatActions', { id: '1' });
      useUIStore.getState().openModal('attachment', { chatId: '2' });

      const state = useUIStore.getState();
      expect(state.activeModal).toBe('attachment');
      expect(state.modalData).toEqual({ chatId: '2' });
    });

    it('closeModal clears both activeModal and modalData', () => {
      useUIStore.getState().openModal('share', { url: 'test' });
      useUIStore.getState().closeModal();

      const state = useUIStore.getState();
      expect(state.activeModal).toBeNull();
      expect(state.modalData).toBeNull();
    });

    it('closeModal is safe to call when no modal is open', () => {
      useUIStore.getState().closeModal();
      expect(useUIStore.getState().activeModal).toBeNull();
    });

    it('openModal supports all ModalType variants used in Figma screens', () => {
      // Screen 3: chatActions, Screen 5: attachment, Screen 14: share,
      // Settings: settings, New chat: newChat, Edit profile: editProfile
      const modalTypes = [
        'chatActions',
        'attachment',
        'share',
        'settings',
        'newChat',
        'editProfile',
      ] as const;

      for (const modalType of modalTypes) {
        useUIStore.getState().openModal(modalType);
        expect(useUIStore.getState().activeModal).toBe(modalType);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 4: Edit Mode
  // -----------------------------------------------------------------------

  describe('toggleEditMode', () => {
    it('toggles isEditMode from false to true', () => {
      expect(useUIStore.getState().isEditMode).toBe(false);
      useUIStore.getState().toggleEditMode();
      expect(useUIStore.getState().isEditMode).toBe(true);
    });

    it('toggles from true back to false and clears selectedItems', () => {
      // Enter edit mode
      useUIStore.getState().toggleEditMode();

      // Select a few items
      useUIStore.getState().toggleSelectedItem('conv-1');
      useUIStore.getState().toggleSelectedItem('conv-2');
      expect(useUIStore.getState().selectedItems.size).toBe(2);

      // Exit edit mode
      useUIStore.getState().toggleEditMode();
      expect(useUIStore.getState().isEditMode).toBe(false);
      expect(useUIStore.getState().selectedItems.size).toBe(0);
    });

    it('clears selectedItems when entering edit mode as well', () => {
      // Manually add selected items (possible via store internals)
      useUIStore.getState().toggleSelectedItem('conv-1');
      expect(useUIStore.getState().selectedItems.size).toBe(1);

      // Entering edit mode resets selections
      useUIStore.getState().toggleEditMode();
      expect(useUIStore.getState().isEditMode).toBe(true);
      expect(useUIStore.getState().selectedItems.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 4b: Selected Items Management
  // -----------------------------------------------------------------------

  describe('selectedItems management', () => {
    it('toggleSelectedItem adds item to selectedItems Set', () => {
      useUIStore.getState().toggleSelectedItem('conv-1');

      const items = useUIStore.getState().selectedItems;
      expect(items.has('conv-1')).toBe(true);
      expect(items.size).toBe(1);
    });

    it('toggleSelectedItem on same item twice removes it (Set semantics)', () => {
      useUIStore.getState().toggleSelectedItem('conv-1');
      useUIStore.getState().toggleSelectedItem('conv-1');
      expect(useUIStore.getState().selectedItems.size).toBe(0);
    });

    it('toggleSelectedItem removes present item while keeping others', () => {
      useUIStore.getState().toggleSelectedItem('conv-1');
      useUIStore.getState().toggleSelectedItem('conv-2');
      useUIStore.getState().toggleSelectedItem('conv-1');

      const items = useUIStore.getState().selectedItems;
      expect(items.has('conv-1')).toBe(false);
      expect(items.has('conv-2')).toBe(true);
      expect(items.size).toBe(1);
    });

    it('clearSelectedItems empties the entire Set', () => {
      useUIStore.getState().toggleSelectedItem('conv-1');
      useUIStore.getState().toggleSelectedItem('conv-2');
      useUIStore.getState().toggleSelectedItem('conv-3');
      expect(useUIStore.getState().selectedItems.size).toBe(3);

      useUIStore.getState().clearSelectedItems();
      expect(useUIStore.getState().selectedItems.size).toBe(0);
    });

    it('toggleSelectedItem toggles — adds if absent, removes if present', () => {
      // Add
      useUIStore.getState().toggleSelectedItem('conv-1');
      expect(useUIStore.getState().selectedItems.has('conv-1')).toBe(true);

      // Remove
      useUIStore.getState().toggleSelectedItem('conv-1');
      expect(useUIStore.getState().selectedItems.has('conv-1')).toBe(false);
    });

    it('manages multiple items independently', () => {
      useUIStore.getState().toggleSelectedItem('a');
      useUIStore.getState().toggleSelectedItem('b');
      useUIStore.getState().toggleSelectedItem('c');
      expect(useUIStore.getState().selectedItems.size).toBe(3);

      useUIStore.getState().toggleSelectedItem('b');
      const items = useUIStore.getState().selectedItems;
      expect(items.has('a')).toBe(true);
      expect(items.has('b')).toBe(false);
      expect(items.has('c')).toBe(true);
      expect(items.size).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 5: Mobile Navigation — R15: push/pop stack navigation
  // -----------------------------------------------------------------------

  describe('mobile navigation — R15: push/pop stack navigation', () => {
    it('default isMobileNavOpen is true — chat list is visible', () => {
      expect(useUIStore.getState().isMobileNavOpen).toBe(true);
    });

    it('pushMobileNav sets isMobileNavOpen to false — hides list, shows detail', () => {
      useUIStore.getState().pushMobileNav('/chat/123');
      expect(useUIStore.getState().isMobileNavOpen).toBe(false);
    });

    it('popMobileNav sets isMobileNavOpen to true when stack empties', () => {
      useUIStore.getState().pushMobileNav('/chat/123');
      expect(useUIStore.getState().isMobileNavOpen).toBe(false);

      useUIStore.getState().popMobileNav();
      expect(useUIStore.getState().isMobileNavOpen).toBe(true);
    });

    it('multiple pushMobileNav calls build a stack; pops drain it', () => {
      useUIStore.getState().pushMobileNav('/chat/123');
      useUIStore.getState().pushMobileNav('/contact/456');
      expect(useUIStore.getState().isMobileNavOpen).toBe(false);

      // Pop one — still one item in stack, list stays hidden
      useUIStore.getState().popMobileNav();
      expect(useUIStore.getState().isMobileNavOpen).toBe(false);

      // Pop last — stack empty, list restored
      useUIStore.getState().popMobileNav();
      expect(useUIStore.getState().isMobileNavOpen).toBe(true);
    });

    it('popMobileNav on empty stack keeps isMobileNavOpen true', () => {
      // Already empty — pop should be a no-op
      useUIStore.getState().popMobileNav();
      expect(useUIStore.getState().isMobileNavOpen).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 6: Search State Management
  // -----------------------------------------------------------------------

  describe('search state management', () => {
    it('setSearchQuery updates the searchQuery string', () => {
      useUIStore.getState().setSearchQuery('hello world');
      expect(useUIStore.getState().searchQuery).toBe('hello world');
    });

    it('setSearchActive(true) activates search', () => {
      useUIStore.getState().setSearchActive(true);
      expect(useUIStore.getState().isSearchActive).toBe(true);
    });

    it('setSearchActive(false) deactivates search and clears query', () => {
      useUIStore.getState().setSearchQuery('test');
      useUIStore.getState().setSearchActive(true);

      useUIStore.getState().setSearchActive(false);
      expect(useUIStore.getState().isSearchActive).toBe(false);
      expect(useUIStore.getState().searchQuery).toBe('');
    });

    it('clearSearch resets both searchQuery and isSearchActive', () => {
      useUIStore.getState().setSearchQuery('test');
      useUIStore.getState().setSearchActive(true);

      useUIStore.getState().clearSearch();
      expect(useUIStore.getState().searchQuery).toBe('');
      expect(useUIStore.getState().isSearchActive).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 7: Toast Notifications
  // -----------------------------------------------------------------------

  describe('showToast / hideToast', () => {
    it('showToast sets toastMessage and toastType', () => {
      useUIStore.getState().showToast('Message sent', 'success');

      const state = useUIStore.getState();
      expect(state.toastMessage).toBe('Message sent');
      expect(state.toastType).toBe('success');
    });

    it('showToast supports all toast types: success, error, info', () => {
      const types = ['success', 'error', 'info'] as const;

      for (const type of types) {
        useUIStore.getState().showToast(`Toast ${type}`, type);
        expect(useUIStore.getState().toastType).toBe(type);
        expect(useUIStore.getState().toastMessage).toBe(`Toast ${type}`);
      }
    });

    it('hideToast clears the toast', () => {
      useUIStore.getState().showToast('Temporary', 'success');
      useUIStore.getState().hideToast();

      expect(useUIStore.getState().toastMessage).toBeNull();
      expect(useUIStore.getState().toastType).toBeNull();
    });

    it('hideToast is safe when no toast is showing', () => {
      useUIStore.getState().hideToast();
      expect(useUIStore.getState().toastMessage).toBeNull();
      expect(useUIStore.getState().toastType).toBeNull();
    });

    it('showToast auto-dismisses after 3 seconds', () => {
      useUIStore.getState().showToast('Auto dismiss', 'info');
      expect(useUIStore.getState().toastMessage).toBe('Auto dismiss');

      // Advance past the auto-dismiss timeout (3 000 ms)
      vi.advanceTimersByTime(3_000);

      expect(useUIStore.getState().toastMessage).toBeNull();
      expect(useUIStore.getState().toastType).toBeNull();
    });

    it('successive showToast replaces previous toast and resets timer', () => {
      useUIStore.getState().showToast('First', 'success');

      // Advance partially — should NOT dismiss yet
      vi.advanceTimersByTime(2_000);
      expect(useUIStore.getState().toastMessage).toBe('First');

      // Replace with new toast (resets timer)
      useUIStore.getState().showToast('Second', 'error');
      expect(useUIStore.getState().toastMessage).toBe('Second');
      expect(useUIStore.getState().toastType).toBe('error');

      // Advance another 2 s — old timer would have fired, but new one hasn't
      vi.advanceTimersByTime(2_000);
      expect(useUIStore.getState().toastMessage).toBe('Second');

      // Advance remaining 1 s to complete new timer (total 3 s from second toast)
      vi.advanceTimersByTime(1_000);
      expect(useUIStore.getState().toastMessage).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 8: resetAll — Called on Logout
  // -----------------------------------------------------------------------

  describe('resetAll — called on logout', () => {
    it('returns the store to its complete initial state', () => {
      // Populate every area of state with non-default values
      const s = useUIStore.getState();
      s.setActiveTab('settings');
      s.openModal('chatActions', { id: 'test' });
      s.toggleEditMode();
      s.toggleSelectedItem('conv-1');
      s.toggleSelectedItem('conv-2');
      s.pushMobileNav('/chat/123');
      s.setSearchQuery('hello');
      s.setSearchActive(true);
      s.showToast('Active toast', 'success');

      // Reset
      useUIStore.getState().resetAll();

      // Assert ALL state matches initial defaults
      const reset = useUIStore.getState();
      expect(reset.activeTab).toBe('chats');
      expect(reset.activeModal).toBeNull();
      expect(reset.modalData).toBeNull();
      expect(reset.isEditMode).toBe(false);
      expect(reset.selectedItems.size).toBe(0);
      expect(reset.isMobileNavOpen).toBe(true);
      expect(reset.searchQuery).toBe('');
      expect(reset.isSearchActive).toBe(false);
      expect(reset.toastMessage).toBeNull();
      expect(reset.toastType).toBeNull();
    });

    it('cancels any pending toast auto-dismiss timer', () => {
      useUIStore.getState().showToast('Before reset', 'info');
      useUIStore.getState().resetAll();

      // Advance past where the timer would fire
      vi.advanceTimersByTime(5_000);

      // Toast should remain null — timer was cancelled
      expect(useUIStore.getState().toastMessage).toBeNull();
      expect(useUIStore.getState().toastType).toBeNull();
    });

    it('provides resetAll action for logout cleanup', () => {
      // Confirm the action exists on the store interface
      expect(typeof useUIStore.getState().resetAll).toBe('function');
    });
  });
});
