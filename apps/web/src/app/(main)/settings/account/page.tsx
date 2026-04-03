'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import AccountSettings from '@/components/settings/AccountSettings';

/* ==========================================================================
 * AccountSettingsPage — Next.js App Router page for /settings/account
 *
 * Thin wrapper that wires the reusable AccountSettings component
 * to Next.js navigation. All UI logic lives in the standalone
 * component at @/components/settings/AccountSettings.tsx per AAP
 * §0.2.3 requirement.
 * ========================================================================== */

/**
 * Account settings page route.
 *
 * Delegates all rendering to the reusable AccountSettings component
 * and provides navigation callbacks via Next.js useRouter.
 */
export default function AccountSettingsPage() {
  const router = useRouter();

  return (
    <AccountSettings
      onBack={() => router.back()}
      onRowClick={(label) => {
        /* Navigate to the selected sub-setting page when routes are available */
        const slug = label.toLowerCase().replace(/\s+/g, '-');
        router.push(`/settings/account/${slug}`);
      }}
    />
  );
}
