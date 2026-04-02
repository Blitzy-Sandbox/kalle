'use client';

import React from 'react';

/* ============================================================
 * TabBar — Bottom 5-Tab Navigation Bar
 *
 * Implements the iOS-style tab bar from Figma file miK1B6qEPrUnRZ9wwZNrW2,
 * node 0:9004. Appears on all main screens with active/inactive states.
 *
 * Figma specifications:
 * - Container: 375×83px (49px tabs + 34px safe area)
 * - Background: #F6F6F6 (bg-nav)
 * - Top shadow: 0px -0.33px 0px rgba(166,166,170,1) (shadow-tab)
 * - Tab cells: 75×49px each, bg rgba(249,249,249,0.94)
 * - Active: #007AFF (text-blue-ios)
 * - Inactive: rgba(84,84,88,0.65)
 * - Labels: SF Pro Text 500, 10px, lineHeight 1.193em, letterSpacing 1%
 * ============================================================ */

/**
 * Union type for all valid tab identifiers.
 * Maps 1:1 to the 5 main navigation tabs in the application.
 */
export type TabId = 'status' | 'calls' | 'camera' | 'chats' | 'settings';

/**
 * Props for the TabBar component.
 */
export interface TabBarProps {
  /** Currently active tab — controls which tab renders in blue (#007AFF) */
  activeTab: TabId;
  /** Callback fired when any tab button is pressed */
  onTabPress: (tab: TabId) => void;
  /** Optional unread message count badge displayed on the Chats tab */
  chatUnreadCount?: number;
  /** Additional CSS class names to merge onto the root nav element */
  className?: string;
}

/* ============================================================
 * Inline SVG Icon Components
 *
 * Each icon is exported from Figma node 0:9004 (Tab Bar group).
 * SVG paths are exact Figma exports with fill changed to
 * "currentColor" so the parent's text-color class controls
 * the rendered fill color.
 *
 * Icon sizes match Figma layout specs:
 * - Status: 26×25px (viewBox 0 0 26 25)
 * - Calls:  23×23px (viewBox 0 0 23 23)
 * - Camera: 26×22px (viewBox 0 0 26 22)
 * - Chats:  31×21px (viewBox 0 0 31 21)
 * - Settings: 25×25px (viewBox 0 0 25 25)
 * ============================================================ */

/** Status tab icon — double concentric circles (Figma node 0:9040) */
const StatusIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="26"
    height="25"
    viewBox="0 0 26 25"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M21.7629 3.8259C19.3915 1.39585 16.1481 0 12.6832 0C9.21939 0 5.97604 1.39585 3.60456 3.8259C3.37158 4.06464 3.37624 4.44706 3.61498 4.68004C3.85373 4.91303 4.23614 4.90837 4.46913 4.66962C6.61554 2.4702 9.54827 1.20803 12.6832 1.20803L13.0318 1.21321C16.0354 1.30281 18.8315 2.55166 20.8984 4.66962C21.1314 4.90837 21.5138 4.91303 21.7525 4.68004C21.9913 4.44706 21.9959 4.06464 21.7629 3.8259ZM21.7446 12.6844C21.7446 7.68052 17.6882 3.6241 12.6844 3.6241C7.68052 3.6241 3.6241 7.68052 3.6241 12.6844C3.6241 17.6882 7.68052 21.7446 12.6844 21.7446C17.6882 21.7446 21.7446 17.6882 21.7446 12.6844ZM0.486762 9.19286C0.578412 8.87211 0.912731 8.68638 1.23348 8.77803C1.55424 8.86968 1.73996 9.204 1.64831 9.52475C1.35728 10.5433 1.20803 11.6036 1.20803 12.6844C1.20803 17.9304 4.75826 22.4708 9.75969 23.7848C10.0823 23.8696 10.2752 24.1999 10.1904 24.5225C10.1056 24.8451 9.77536 25.038 9.45272 24.9532C3.92354 23.5006 0 18.4827 0 12.6844C0 11.491 0.164973 10.319 0.486762 9.19286ZM24.1499 8.82125C24.471 8.73082 24.8046 8.91781 24.895 9.23891C25.2082 10.351 25.3687 11.5073 25.3687 12.6844C25.3687 18.524 21.3896 23.5681 15.8066 24.9814C15.4832 25.0633 15.1546 24.8675 15.0728 24.5441C14.9909 24.2207 15.1867 23.8922 15.5101 23.8103C20.5601 22.5319 24.1607 17.9678 24.1607 12.6844C24.1607 11.6183 24.0155 10.5722 23.7322 9.56638C23.6418 9.24529 23.8288 8.91168 24.1499 8.82125ZM12.6844 4.83214C8.34769 4.83214 4.83214 8.34769 4.83214 12.6844C4.83214 17.021 8.34769 20.5366 12.6844 20.5366C17.021 20.5366 20.5366 17.021 20.5366 12.6844C20.5366 8.34769 17.021 4.83214 12.6844 4.83214Z"
      fill="currentColor"
    />
  </svg>
);

/** Calls tab icon — phone handset (Figma node 0:9033) */
const CallsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="23"
    height="23"
    viewBox="0 0 23 23"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M21.9811 21.027C22.2093 20.8183 22.4054 20.5768 22.563 20.3106C23.4439 18.8217 22.9511 16.9005 21.4621 16.0196L18.1189 14.0414L17.9526 13.951C17.1655 13.5587 16.2288 13.5849 15.4611 14.0309L14.4194 14.6363L14.2983 14.699C13.7654 14.9437 13.1297 14.8348 12.7083 14.4134L8.58659 10.2917L8.49492 10.1908C8.12185 9.73831 8.06436 9.09588 8.36374 8.58064L8.96905 7.53889C9.44696 6.7164 9.44294 5.69983 8.95855 4.88114L6.98042 1.53787C6.09948 0.0489404 4.17831 -0.443917 2.68939 0.437038C2.42315 0.594562 2.18172 0.790654 1.97295 1.01893C0.48712 2.64357 -0.177995 4.19044 0.0407101 5.65722C0.488911 8.66315 2.60224 12.0966 6.35686 15.9945L6.68293 16.3166L7.00551 16.6431L7.01187 16.6384C10.9034 20.3978 14.3368 22.5111 17.3428 22.9593C18.8096 23.178 20.3564 22.5129 21.9811 21.027ZM21.1627 20.1323C19.7676 21.4081 18.5608 21.9149 17.5216 21.76C14.91 21.3706 11.8021 19.5053 8.21468 16.1109L7.62352 15.5434L7.20906 15.1319C3.61834 11.4036 1.64212 8.17516 1.24002 5.47839C1.08507 4.43918 1.59186 3.23235 2.86774 1.83727C2.9957 1.69735 3.14367 1.57717 3.30685 1.48062C4.21942 0.940681 5.3969 1.24276 5.93684 2.15532L7.91496 5.4986C8.17579 5.93943 8.17795 6.48682 7.92062 6.9297L7.31531 7.97144C6.76226 8.92326 6.86221 10.1166 7.55935 10.9622L7.68913 11.1071L11.8509 15.2708C12.6293 16.0492 13.8085 16.2583 14.8044 15.801L14.9777 15.7126L16.0703 15.0794C16.4823 14.84 16.9867 14.8244 17.4117 15.0362L17.5393 15.1065L20.8447 17.0632C21.7572 17.6031 22.0593 18.7806 21.5194 19.6931C21.4228 19.8563 21.3026 20.0043 21.1627 20.1323Z"
      fill="currentColor"
    />
  </svg>
);

/** Camera tab icon — camera body with lens (Figma node 0:9025) */
const CameraIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="26"
    height="22"
    viewBox="0 0 26 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M17.0499 0.780928C16.4925 0.27823 15.7684 0 15.0178 0H10.9065C10.156 0 9.43219 0.278087 8.87477 0.780552L8.06783 1.50793C7.51943 2.00227 6.80729 2.27586 6.06897 2.27586C2.71717 2.27586 0 4.99303 0 8.34483V15.931C0 19.2828 2.71717 22 6.06897 22H19.7241C23.0759 22 25.7931 19.2828 25.7931 15.931V8.34483C25.7931 4.99303 23.0759 2.27586 19.7241 2.27586L19.5071 2.26694C18.9314 2.21956 18.3848 1.98467 17.9529 1.5952L17.0499 0.780928ZM10.9065 1.21379H15.0178C15.4682 1.21379 15.9026 1.38073 16.2371 1.68235L17.1401 2.49662C17.7686 3.06342 18.5655 3.40733 19.4075 3.47665L19.6743 3.48863C22.4056 3.48966 24.5793 5.66339 24.5793 8.34483V15.931C24.5793 18.6125 22.4056 20.7862 19.7241 20.7862H6.06897C3.38753 20.7862 1.21379 18.6125 1.21379 15.931V8.34483C1.21379 5.73586 3.27162 3.60753 5.8527 3.49439L6.30788 3.48286C7.26022 3.42861 8.16848 3.05134 8.88052 2.4095L9.68746 1.68212C10.0219 1.38065 10.4562 1.21379 10.9065 1.21379ZM12.8966 5.31034C16.1087 5.31034 18.7126 7.9143 18.7126 11.1264C18.7126 14.3386 16.1087 16.9425 12.8966 16.9425C9.68441 16.9425 7.08046 14.3386 7.08046 11.1264C7.08046 7.9143 9.68441 5.31034 12.8966 5.31034ZM8.29425 11.1264C8.29425 8.58466 10.3548 6.52414 12.8966 6.52414C15.4383 6.52414 17.4988 8.58466 17.4988 11.1264C17.4988 13.6682 15.4383 15.7287 12.8966 15.7287C10.3548 15.7287 8.29425 13.6682 8.29425 11.1264Z"
      fill="currentColor"
    />
  </svg>
);

/** Chats tab icon — double speech bubble (Figma node 0:9019, boolean operation) */
const ChatsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="31"
    height="21"
    viewBox="0 0 31 21"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 0C18.6274 0 24 4.25263 24 9.49851C24 14.7444 17.6406 18.8634 10.3681 18.3883C7.70922 21.1085 4.66783 21.0465 4.51201 20.8586C4.35619 20.6707 4.7425 20.5054 5.38145 19.5059C6.0204 18.5064 6.0204 17.4176 4.78304 16.6474L4.7034 16.6027L4.62171 16.5619C1.54057 15.1153 0 12.7609 0 9.49851C0 3.65377 5.37258 0 12 0ZM19.7804 0.502277C26.0021 0.603488 31 4.07282 31 9.57383C31 12.5898 29.6173 14.7935 26.852 16.1849L26.4926 16.3604L26.4163 16.4031C25.2305 17.1389 25.2305 18.1789 25.8428 19.1338C26.4551 20.0886 26.8253 20.2465 26.676 20.426C26.5267 20.6055 23.612 20.6647 21.0639 18.0662C20.5147 18.1019 19.971 18.1104 19.4353 18.0933C23.0637 16.2416 25.5 13.1378 25.5 9.49851C25.5 5.92825 23.4481 2.80265 20.2847 0.805168L19.9941 0.626706L19.7804 0.502277Z"
      fill="currentColor"
    />
  </svg>
);

/** Settings tab icon — gear/cog (Figma node 0:9009) */
const SettingsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="25"
    height="25"
    viewBox="0 0 25 25"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M21.0124 5.39443L20.9052 5.27116L21.4223 4.91979L21.5044 4.82269C21.736 4.48992 21.6991 4.05604 21.4223 3.77926C21.1074 3.46432 20.5968 3.46432 20.2818 3.77926L19.7459 4.10886L19.6053 3.98651C19.0031 3.48337 18.3467 3.04302 17.6463 2.67592L17.4627 2.58366L17.674 2.04408L17.7108 1.93548C17.8086 1.53821 17.6119 1.14163 17.2468 0.98662C16.8368 0.812592 16.3633 1.00387 16.1893 1.41386L15.9667 1.96572L15.8107 1.91396C15.072 1.68318 14.3001 1.52768 13.5044 1.4569L13.2994 1.44254L13.3064 0.806497L13.2979 0.692127C13.2326 0.288222 12.8967 0 12.5 0C12.0546 0 11.6935 0.36106 11.6935 0.80645V1.44153L11.4941 1.4563C10.696 1.52806 9.92244 1.68439 9.18315 1.91626L9.00099 1.9758L8.82416 1.4235L8.77339 1.32071C8.56163 0.970639 8.14216 0.829255 7.77433 0.977867C7.36137 1.14471 7.16186 1.61474 7.32871 2.0277L7.51813 2.59173L7.34779 2.67837C6.64921 3.0456 5.99465 3.48522 5.39443 3.98753L5.25805 4.10483L4.81898 3.67849L4.72188 3.59631C4.38911 3.36479 3.95523 3.40168 3.67845 3.67845C3.36352 3.99339 3.36352 4.50401 3.67845 4.81895L4.11693 5.24394L3.98651 5.39463C3.48337 5.99684 3.04302 6.65323 2.67592 7.35367L2.58568 7.53124L2.04408 7.32597L1.93548 7.28918C1.53821 7.19139 1.14163 7.38802 0.98662 7.7532C0.812592 8.16318 1.00387 8.63662 1.41386 8.81065L1.96875 9.02216L1.91399 9.18913C1.66419 9.98874 1.50257 10.8273 1.44109 11.6935H0.806497L0.692127 11.7021C0.288222 11.7673 0 12.1033 0 12.5C0 12.9454 0.36106 13.3064 0.80645 13.3064L1.44153 13.3054L1.45612 13.5039C1.52757 14.3 1.68315 15.0718 1.91386 15.8094L1.96975 15.9778L1.41391 16.1893L1.31197 16.2419C0.965652 16.4597 0.831612 16.8816 0.98662 17.2468C1.16065 17.6567 1.63408 17.848 2.04407 17.674L2.58568 17.4677L2.6752 17.6461C3.04292 18.3467 3.48342 19.003 3.98691 19.6048L4.11088 19.7469L3.67849 20.181L3.59631 20.2781C3.36479 20.6108 3.40168 21.0447 3.67845 21.3215C3.99339 21.6364 4.50401 21.6364 4.81895 21.3215L5.24999 20.8881L5.39463 21.0134C5.99684 21.5166 6.65323 21.9569 7.35367 22.324L7.53829 22.4163L7.32597 22.9559L7.28918 23.0645C7.19139 23.4617 7.38802 23.8583 7.7532 24.0133C8.16318 24.1874 8.63662 23.9961 8.81065 23.5861L9.02922 23.0322L9.18913 23.086C9.92762 23.3167 10.6993 23.4722 11.4953 23.5436L11.6935 23.5574V24.1935L11.7021 24.3078C11.7673 24.7117 12.1033 25 12.5 25C12.9454 25 13.3064 24.6389 13.3064 24.1935L13.3054 23.5574L13.505 23.5437C14.3033 23.472 15.0772 23.3157 15.8167 23.0837L15.9929 23.0241L16.1758 23.5764L16.2266 23.6792C16.4383 24.0293 16.8578 24.1707 17.2256 24.0221C17.6386 23.8552 17.8381 23.3852 17.6712 22.9723L17.4768 22.4092L17.6522 22.3216C18.3507 21.9543 19.0053 21.5147 19.6055 21.0124L19.7409 20.8941L20.181 21.3215L20.2781 21.4036C20.6108 21.6352 21.0447 21.5983 21.3215 21.3215C21.6364 21.0066 21.6364 20.4959 21.3215 20.181L20.882 19.756L21.0134 19.6053C21.5166 19.0031 21.9569 18.3467 22.324 17.6463L22.4082 17.4768L22.9559 17.674L23.0645 17.7108C23.4617 17.8086 23.8583 17.6119 24.0133 17.2468C24.1874 16.8368 23.9961 16.3633 23.5861 16.1893L23.0282 15.9818L23.0319 15.979C23.2926 15.1895 23.4669 14.3608 23.5436 13.5044L23.5574 13.3054L24.1935 13.3064L24.3078 13.2979C24.7117 13.2326 25 12.8967 25 12.5C25 12.0546 24.6389 11.6935 24.1935 11.6935L23.5574 11.6925L23.5437 11.4941C23.4719 10.696 23.3156 9.92244 23.0837 9.18315L23.0322 9.02821L23.5764 8.82416L23.6792 8.77339C24.0293 8.56163 24.1707 8.14216 24.0221 7.77433C23.8552 7.36137 23.3852 7.16186 22.9723 7.32871L22.4102 7.52317L22.3216 7.34779C21.9543 6.64921 21.5147 5.99465 21.0124 5.39443ZM12.5 2.62096C10.9162 2.62096 9.41955 2.99364 8.09281 3.65607L10.2673 7.42351C10.9504 7.12266 11.7057 6.95563 12.5 6.95563C15.3573 6.95563 17.7099 9.11714 18.0116 11.8943H22.3607C22.0478 6.72035 17.7526 2.62096 12.5 2.62096ZM7.04541 4.26202C4.37893 6.03112 2.62096 9.06025 2.62096 12.5C2.62096 15.9397 4.37893 18.9688 7.04541 20.7379L9.22091 16.9712C7.84724 15.9621 6.95563 14.3351 6.95563 12.5C6.95563 10.6648 7.84724 9.03789 9.22091 8.02878L7.04541 4.26202ZM22.3608 13.1046H18.0117C17.7104 15.8823 15.3577 18.0443 12.5 18.0443C11.7057 18.0443 10.9504 17.8773 10.2673 17.5764L8.09281 21.3439C9.41955 22.0063 10.9162 22.379 12.5 22.379C17.753 22.379 22.0484 18.2791 22.3608 13.1046ZM8.16531 12.5C8.16531 10.106 10.106 8.16531 12.5 8.16531C14.8939 8.16531 16.8346 10.106 16.8346 12.5C16.8346 14.8939 14.8939 16.8346 12.5 16.8346C10.106 16.8346 8.16531 14.8939 8.16531 12.5Z"
      fill="currentColor"
    />
  </svg>
);

/**
 * Configuration for all five navigation tabs.
 * Order matches Figma layout: Status (Tab 1) through Settings (Tab 5).
 */
const TAB_CONFIG: ReadonlyArray<{
  readonly id: TabId;
  readonly label: string;
  readonly Icon: React.FC<{ className?: string }>;
}> = [
  { id: 'status', label: 'Status', Icon: StatusIcon },
  { id: 'calls', label: 'Calls', Icon: CallsIcon },
  { id: 'camera', label: 'Camera', Icon: CameraIcon },
  { id: 'chats', label: 'Chats', Icon: ChatsIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
] as const;

/**
 * TabBar — Fixed bottom navigation bar with 5 tabs.
 *
 * Renders the iOS-style tab bar present on all main application screens.
 * Active tab is indicated by blue (#007AFF) icon and label.
 * Inactive tabs use rgba(84,84,88,0.65) gray.
 *
 * Accessibility:
 * - Wrapped in `<nav>` with `aria-label="Main navigation"`
 * - Each tab is a `<button>` with `aria-current="page"` when active
 * - Keyboard focus ring (`:focus-visible`) on all tab buttons
 * - Icons marked `aria-hidden="true"` (labels provide text)
 *
 * @example
 * ```tsx
 * <TabBar
 *   activeTab="chats"
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 *   chatUnreadCount={3}
 * />
 * ```
 */
export const TabBar: React.FC<TabBarProps> = ({
  activeTab,
  onTabPress,
  chatUnreadCount,
  className = '',
}) => {
  return (
    <nav
      aria-label="Main navigation"
      className={[
        'fixed bottom-0 start-0 end-0 z-40',
        'bg-nav shadow-tab',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Tab row — 5 equal-width tabs, 49px tall per Figma layout_MQCI5J */}
      <div className="flex h-[49px]" role="tablist">
        {TAB_CONFIG.map((tab) => {
          const isActive = activeTab === tab.id;
          const colorClass = isActive
            ? 'text-blue-ios'
            : 'text-[rgba(84,84,88,0.65)]';

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? 'page' : undefined}
              aria-label={tab.label}
              onClick={() => onTabPress(tab.id)}
              className={[
                'flex-1 flex flex-col items-center justify-start',
                'pt-[6px] bg-[rgba(249,249,249,0.94)]',
                colorClass,
                'focus:outline-none',
                'focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
              ].join(' ')}
            >
              {/* Icon container — centered, accommodates tallest icon (26px) */}
              <div className="relative flex h-[26px] items-center justify-center">
                <tab.Icon />
                {/* Unread count badge — only on Chats tab when count > 0 */}
                {tab.id === 'chats' &&
                  chatUnreadCount !== undefined &&
                  chatUnreadCount > 0 && (
                    <span
                      aria-label={`${chatUnreadCount > 99 ? '99+' : chatUnreadCount} unread messages`}
                      className={[
                        'absolute -top-1 -right-3',
                        'min-w-[16px] h-[16px] rounded-full',
                        'bg-red-ios text-white',
                        'text-[10px] font-bold leading-none',
                        'flex items-center justify-center',
                        'px-[3px]',
                      ].join(' ')}
                    >
                      {chatUnreadCount > 99 ? '99+' : chatUnreadCount}
                    </span>
                  )}
              </div>
              {/* Label — 10px font-medium, 1% letter spacing per Figma style_0TYJ6I */}
              <span className="mt-[3px] text-[10px] font-medium leading-[1.193em] tracking-[0.01em]">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
      {/* Safe area inset — 34px for iOS home indicator (Figma home indicator area) */}
      <div className="h-[34px] bg-nav" />
    </nav>
  );
};

export default TabBar;
