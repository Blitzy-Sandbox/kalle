import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * Active tab in the bottom tab bar.
 * Maps to Figma Screen 1 TabBar component with five tabs:
 *   Status · Calls · Camera · Chats · Settings
 */
export type TabId = 'status' | 'calls' | 'camera' | 'chats' | 'settings';

/**
 * Active modal / action-sheet overlay.
 *
 * Maps to various Figma screens:
 * - chatActions : Screen 3  (Mute, Contact Info, Export Chat, Clear Chat, Delete Chat)
 * - attachment  : Screen 5  (Camera, Photo & Video Library, Document, Location, Contact)
 * - share       : Screen 14 (Mail, Message, More)
 * - settings    : Screen 14 variant (general settings action sheet)
 * - newChat     : Compose new-conversation modal
 * - editProfile : Profile edit modal overlay
 *
 * `null` means no modal is open.
 */
export type ModalType =
  | 'chatActions'
  | 'attachment'
  | 'share'
  | 'settings'
  | 'newChat'
  | 'editProfile'
  | null;

// ---------------------------------------------------------------------------
// Toast variant union (kept narrow to avoid stringly-typed comparisons)
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error' | 'info';

// ---------------------------------------------------------------------------
// State Interface
// ---------------------------------------------------------------------------

interface UIState {
  // --- Tab Navigation (Figma Screen 1: 5-tab bottom bar) -----------------
  /** Currently active bottom tab. Default: `'chats'`. */
  activeTab: TabId;

  // --- Modal / Action-Sheet State ----------------------------------------
  /** Currently open modal / action sheet. `null` = none open. */
  activeModal: ModalType;
  /** Optional payload data passed to the active modal. */
  modalData: Record<string, unknown> | null;

  // --- Mobile Navigation (R15) -------------------------------------------
  /**
   * Whether the mobile list view is visible.
   * At ≤767 px the conversation list and chat view must *never* be visible
   * simultaneously (R15). `true` = showing list; `false` = showing detail.
   */
  isMobileNavOpen: boolean;
  /** Stack of route strings for push/pop mobile navigation. */
  mobileNavStack: string[];

  // --- Edit Mode (Figma Screen 2 / 12) -----------------------------------
  /** Whether edit-mode is active (selection circles visible). */
  isEditMode: boolean;
  /** IDs of selected items in edit-mode (conversations or calls). */
  selectedItems: Set<string>;

  // --- Search (R21: client-side only) ------------------------------------
  /** Current search-query text. */
  searchQuery: string;
  /** Whether the search input is focused / active. */
  isSearchActive: boolean;

  // --- Transient Toast / Notification ------------------------------------
  /** Transient toast message. `null` = hidden. */
  toastMessage: string | null;
  /** Toast visual variant. `null` when hidden. */
  toastType: ToastType | null;

  // --- Actions -----------------------------------------------------------
  setActiveTab: (tab: TabId) => void;

  openModal: (modalType: ModalType, data?: Record<string, unknown>) => void;
  closeModal: () => void;

  toggleEditMode: () => void;
  setEditMode: (enabled: boolean) => void;
  toggleSelectedItem: (itemId: string) => void;
  selectAllItems: (itemIds: string[]) => void;
  clearSelectedItems: () => void;

  setSearchQuery: (query: string) => void;
  setSearchActive: (active: boolean) => void;
  clearSearch: () => void;

  pushMobileNav: (route: string) => void;
  popMobileNav: () => void;
  setMobileNavOpen: (open: boolean) => void;
  resetMobileNav: () => void;

  showToast: (message: string, type: ToastType) => void;
  hideToast: () => void;

  resetAll: () => void;
}

// ---------------------------------------------------------------------------
// Initial state snapshot (extracted for resetAll reuse)
// ---------------------------------------------------------------------------

const INITIAL_STATE: Pick<
  UIState,
  | 'activeTab'
  | 'activeModal'
  | 'modalData'
  | 'isMobileNavOpen'
  | 'mobileNavStack'
  | 'isEditMode'
  | 'selectedItems'
  | 'searchQuery'
  | 'isSearchActive'
  | 'toastMessage'
  | 'toastType'
> = {
  activeTab: 'chats',
  activeModal: null,
  modalData: null,
  isMobileNavOpen: true,
  mobileNavStack: [],
  isEditMode: false,
  selectedItems: new Set<string>(),
  searchQuery: '',
  isSearchActive: false,
  toastMessage: null,
  toastType: null,
};

// ---------------------------------------------------------------------------
// Auto-dismiss delay for toast notifications (milliseconds)
// ---------------------------------------------------------------------------

const TOAST_AUTO_DISMISS_MS = 3_000;

// ---------------------------------------------------------------------------
// Active toast timer reference — allows cancellation on successive calls
// ---------------------------------------------------------------------------

let toastTimerId: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Store Implementation
// ---------------------------------------------------------------------------

/**
 * Zustand store managing all UI navigation, modal, edit-mode, search, and
 * toast state for the WhatsApp clone frontend.
 *
 * This is the most foundational store — it has **zero** dependencies on other
 * stores or shared types.
 */
export const useUIStore = create<UIState>((set, get) => ({
  // ── Initial State ──────────────────────────────────────────────────────
  ...INITIAL_STATE,

  // ── Tab Navigation ─────────────────────────────────────────────────────

  /**
   * Switch the active bottom tab.
   *
   * Side-effects:
   * - Closes any open modal
   * - Exits edit-mode and clears selection
   * - Clears search state
   * - Resets mobile navigation stack (R15)
   */
  setActiveTab: (tab: TabId): void => {
    // Cancel any pending toast timer so a tab switch starts clean
    if (toastTimerId !== null) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }

    set({
      activeTab: tab,
      activeModal: null,
      modalData: null,
      isEditMode: false,
      selectedItems: new Set<string>(),
      searchQuery: '',
      isSearchActive: false,
      isMobileNavOpen: true,
      mobileNavStack: [],
    });
  },

  // ── Modal / Action-Sheet ───────────────────────────────────────────────

  /**
   * Open a modal / action-sheet overlay.
   *
   * @param modalType - The type of modal to open.
   * @param data      - Optional payload data for the modal.
   */
  openModal: (
    modalType: ModalType,
    data?: Record<string, unknown>,
  ): void => {
    set({
      activeModal: modalType,
      modalData: data ?? null,
    });
  },

  /**
   * Close the currently open modal and clear its data.
   */
  closeModal: (): void => {
    set({
      activeModal: null,
      modalData: null,
    });
  },

  // ── Edit Mode (Figma Screen 2 – Chats Edit / Screen 12 – Calls Edit) ──

  /**
   * Toggle edit-mode on/off, clearing the selection in both directions.
   */
  toggleEditMode: (): void => {
    set({
      isEditMode: !get().isEditMode,
      selectedItems: new Set<string>(),
    });
  },

  /**
   * Explicitly set edit-mode to a given value, clearing the selection.
   */
  setEditMode: (enabled: boolean): void => {
    set({
      isEditMode: enabled,
      selectedItems: new Set<string>(),
    });
  },

  /**
   * Toggle the selection of a single item (add if absent, remove if present).
   * Used during edit-mode for batch actions on conversations or calls.
   */
  toggleSelectedItem: (itemId: string): void => {
    const current = get().selectedItems;
    const next = new Set(current);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    set({ selectedItems: next });
  },

  /**
   * Replace the selection with the given set of item IDs ("Select All").
   */
  selectAllItems: (itemIds: string[]): void => {
    set({ selectedItems: new Set(itemIds) });
  },

  /**
   * Clear the selection entirely.
   */
  clearSelectedItems: (): void => {
    set({ selectedItems: new Set<string>() });
  },

  // ── Search (R21: client-side only) ─────────────────────────────────────

  /**
   * Update the search query text.
   * Drives client-side search via the `useSearch` hook.
   */
  setSearchQuery: (query: string): void => {
    set({ searchQuery: query });
  },

  /**
   * Activate or deactivate the search UI.
   * Deactivating also clears the query so results disappear.
   */
  setSearchActive: (active: boolean): void => {
    if (active) {
      set({ isSearchActive: true });
    } else {
      set({ isSearchActive: false, searchQuery: '' });
    }
  },

  /**
   * Clear search state completely (query + active flag).
   */
  clearSearch: (): void => {
    set({ searchQuery: '', isSearchActive: false });
  },

  // ── Mobile Navigation (R15) ────────────────────────────────────────────

  /**
   * Push a route onto the mobile navigation stack.
   * Hides the list view and shows the detail view.
   *
   * Example: `pushMobileNav('/chat/123')` hides the chat list and shows the
   * conversation.
   */
  pushMobileNav: (route: string): void => {
    set((state) => ({
      mobileNavStack: [...state.mobileNavStack, route],
      isMobileNavOpen: false,
    }));
  },

  /**
   * Pop the last route from the mobile navigation stack.
   * When the stack empties the list view is restored.
   */
  popMobileNav: (): void => {
    set((state) => {
      const next = state.mobileNavStack.slice(0, -1);
      return {
        mobileNavStack: next,
        isMobileNavOpen: next.length === 0,
      };
    });
  },

  /**
   * Explicitly set whether the mobile list view is visible.
   * Used when the responsive breakpoint changes (e.g. rotating to desktop).
   */
  setMobileNavOpen: (open: boolean): void => {
    set({ isMobileNavOpen: open });
  },

  /**
   * Reset mobile navigation completely (clear stack, show list).
   */
  resetMobileNav: (): void => {
    set({ mobileNavStack: [], isMobileNavOpen: true });
  },

  // ── Toast / Notification ───────────────────────────────────────────────

  /**
   * Display a transient toast notification.
   * Automatically dismisses after {@link TOAST_AUTO_DISMISS_MS} ms.
   */
  showToast: (message: string, type: ToastType): void => {
    // Cancel any previously scheduled auto-dismiss
    if (toastTimerId !== null) {
      clearTimeout(toastTimerId);
    }

    set({ toastMessage: message, toastType: type });

    toastTimerId = setTimeout(() => {
      toastTimerId = null;
      // Only clear if the message hasn't been replaced in the meantime
      const current = get();
      if (current.toastMessage === message && current.toastType === type) {
        set({ toastMessage: null, toastType: null });
      }
    }, TOAST_AUTO_DISMISS_MS);
  },

  /**
   * Immediately hide the toast notification.
   */
  hideToast: (): void => {
    if (toastTimerId !== null) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    set({ toastMessage: null, toastType: null });
  },

  // ── Full Reset (logout) ────────────────────────────────────────────────

  /**
   * Reset the entire store to its initial state.
   * Called on logout alongside other store resets
   * (authStore.logout, chatStore.clearAll, etc.).
   */
  resetAll: (): void => {
    if (toastTimerId !== null) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    set({
      ...INITIAL_STATE,
      // Ensure a fresh Set instance to prevent mutation of the constant
      selectedItems: new Set<string>(),
      mobileNavStack: [],
    });
  },
}));

// ---------------------------------------------------------------------------
// Derived Selectors
// ---------------------------------------------------------------------------

/** Check whether *any* modal is currently open. */
export const selectIsModalOpen = (): boolean =>
  useUIStore.getState().activeModal !== null;

/** Get the currently active tab ID. */
export const selectActiveTab = (): TabId =>
  useUIStore.getState().activeTab;

/** Check whether edit-mode is currently active. */
export const selectIsEditMode = (): boolean =>
  useUIStore.getState().isEditMode;

/** Get the count of currently selected items. */
export const selectSelectedCount = (): number =>
  useUIStore.getState().selectedItems.size;

/** Check whether a specific item is selected. */
export const selectIsItemSelected = (itemId: string): boolean =>
  useUIStore.getState().selectedItems.has(itemId);

/**
 * Check whether the user is on a mobile detail view (i.e. the list is hidden).
 * Used by layout components to decide between list and detail panels (R15).
 */
export const selectIsMobileDetailView = (): boolean =>
  !useUIStore.getState().isMobileNavOpen;
