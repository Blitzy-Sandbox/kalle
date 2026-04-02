'use client';

import React, { FC, useState, useCallback, useMemo } from 'react';
import { NavigationBar } from '../common/NavigationBar';
import { Separator } from '../common/Separator';
import { StatusBar } from '../common/StatusBar';

/**
 * Props interface for the EditContact component.
 * Represents all editable fields for a contact and provides
 * handlers for cancel, save, and delete actions.
 */
export interface EditContactProps {
  /** Unique identifier for the contact being edited */
  contactId: string;
  /** Initial first name value */
  firstName: string;
  /** Initial last name value */
  lastName: string;
  /** Initial phone country name (e.g., "New Zealand") */
  phoneCountry: string;
  /** Initial phone type label (e.g., "mobile", "home", "work") */
  phoneType: string;
  /** Initial phone number with country code (e.g., "+1 202 555 0181") */
  phoneNumber: string;
  /** Handler invoked when the user cancels editing (navigates back) */
  onCancel: () => void;
  /** Handler invoked when the user saves changes, receives updated field values */
  onSave: (data: {
    firstName: string;
    lastName: string;
    phoneCountry: string;
    phoneType: string;
    phoneNumber: string;
  }) => void;
  /** Handler invoked when the user taps Delete Contact */
  onDelete: () => void;
  /** Optional additional CSS class name for the root container */
  className?: string;
}

/**
 * Inline disclosure indicator chevron (9×14px, right-pointing arrow).
 * Used in phone country and mobile type selector rows.
 * Stroke color: rgba(60, 60, 67, 0.3) per Figma node fill_IEZPOR.
 */
const ChevronRight: React.FC = () => (
  <svg
    width="9"
    height="14"
    viewBox="0 0 9 14"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="shrink-0"
  >
    <path
      d="M1 1L7 7L1 13"
      stroke="rgba(60,60,67,0.3)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* Shared Tailwind classes for form text inputs (SF Pro Text 400, 16px / 1.3125em) */
const inputClasses = [
  'w-full h-[50px]',
  'ps-4',
  'text-[16px] font-normal leading-[1.3125em] tracking-[-0.033em]',
  'text-black bg-white',
  'border-none outline-none',
  'focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
].join(' ');

/* Shared Tailwind classes for section labels — "Name", "Phone" (SF Pro Text 600, 16px) */
const sectionLabelClasses = [
  'text-[16px] font-semibold leading-[1.3125em] tracking-[-0.033em]',
  'text-black',
].join(' ');

/* Shared Tailwind classes for full-width action row buttons (50px height, 16px text) */
const actionRowClasses = [
  'flex items-center w-full h-[50px]',
  'ps-4',
  'text-[16px] font-normal leading-[1.3125em] tracking-[-0.033em]',
  'bg-white',
  'focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
].join(' ');

/**
 * EditContact — Contact editing form component.
 *
 * Maps 1:1 to Figma Screen 7 (WhatsApp Edit Contact, node 0:10334).
 * Two-column layout: 96px label column + flexible field column.
 * Tracks form dirty state to conditionally enable the Save action.
 *
 * @see https://www.figma.com/design/miK1B6qEPrUnRZ9wwZNrW2?node-id=0-10334
 */
const EditContact: FC<EditContactProps> = ({
  contactId,
  firstName: initialFirstName,
  lastName: initialLastName,
  phoneCountry: initialPhoneCountry,
  phoneType: initialPhoneType,
  phoneNumber: initialPhoneNumber,
  onCancel,
  onSave,
  onDelete,
  className = '',
}) => {
  /* ── Form field state, initialized from props ── */
  const [formState, setFormState] = useState({
    firstName: initialFirstName,
    lastName: initialLastName,
    phoneCountry: initialPhoneCountry,
    phoneType: initialPhoneType,
    phoneNumber: initialPhoneNumber,
  });

  /* ── Dirty-state check: true when any field differs from its initial value ── */
  const isDirty = useMemo(
    () =>
      formState.firstName !== initialFirstName ||
      formState.lastName !== initialLastName ||
      formState.phoneCountry !== initialPhoneCountry ||
      formState.phoneType !== initialPhoneType ||
      formState.phoneNumber !== initialPhoneNumber,
    [
      formState,
      initialFirstName,
      initialLastName,
      initialPhoneCountry,
      initialPhoneType,
      initialPhoneNumber,
    ],
  );

  /* ── Memoized event handlers ── */
  const handleSave = useCallback(() => {
    if (!isDirty) return;
    onSave(formState);
  }, [isDirty, formState, onSave]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const handleDelete = useCallback(() => {
    onDelete();
  }, [onDelete]);

  /** Form submit via Enter key in text inputs triggers Save when dirty */
  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (isDirty) handleSave();
    },
    [isDirty, handleSave],
  );

  return (
    <div
      className={`flex flex-col h-full bg-white ${className}`.trim()}
      data-contact-id={contactId}
    >
      {/* ── iOS Status Bar (decorative, hidden on mobile viewports) ── */}
      <StatusBar />

      {/* ── Navigation Bar: Cancel / Edit Contact / Save ── */}
      <NavigationBar
        title="Edit Contact"
        leftAction="Cancel"
        onLeftAction={handleCancel}
        rightAction={
          <span
            className={`font-semibold ${isDirty ? 'text-blue-ios' : 'text-disabled'}`}
            aria-disabled={!isDirty}
          >
            Save
          </span>
        }
        onRightAction={isDirty ? handleSave : undefined}
      />

      {/* ── Form content area ── */}
      {/* 35px top padding matches Figma gap: y=123 (first field) - y=88 (nav bottom) */}
      <form
        onSubmit={handleFormSubmit}
        className="flex-1 overflow-y-auto pt-[35px]"
        aria-label="Edit contact form"
      >
        {/* ═══════════ NAME SECTION ═══════════ */}
        <div role="group" aria-label="Name fields">
          {/* Row 1: "Name" label (96px column) + First name input */}
          <div className="flex">
            <div className="w-[96px] shrink-0 flex items-center h-[50px]">
              <span className={`ps-4 ${sectionLabelClasses}`}>Name</span>
            </div>
            <div className="flex-1">
              <input
                type="text"
                value={formState.firstName}
                onChange={(e) => setFormState((prev) => ({ ...prev, firstName: e.target.value }))}
                aria-label="First name"
                className={inputClasses}
              />
            </div>
          </div>

          {/* Separator 1: between first and last name — x=112, width=263 */}
          <Separator inset insetLeft={112} />

          {/* Row 2: empty label spacer + Last name input */}
          <div className="flex">
            <div className="w-[96px] shrink-0" aria-hidden="true" />
            <div className="flex-1">
              <input
                type="text"
                value={formState.lastName}
                onChange={(e) => setFormState((prev) => ({ ...prev, lastName: e.target.value }))}
                aria-label="Last name"
                className={inputClasses}
              />
            </div>
          </div>
        </div>

        {/* Separator 2: between Name and Phone sections — x=112, width=263 */}
        <Separator inset insetLeft={112} />

        {/* ═══════════ PHONE SECTION ═══════════ */}
        <div role="group" aria-label="Phone fields">
          {/* Row 3: "Phone" label (96px column) + Country selector */}
          <div className="flex">
            <div className="w-[96px] shrink-0 flex items-center h-[50px]">
              <span className={`ps-4 ${sectionLabelClasses}`}>Phone</span>
            </div>
            <div className="flex-1">
              <button
                type="button"
                className={[
                  'flex items-center justify-between w-full h-[50px]',
                  'ps-4 pe-4',
                  'text-[16px] font-normal leading-[1.3125em] tracking-[-0.033em]',
                  'text-black bg-white',
                  'focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
                ].join(' ')}
                aria-label={`Phone country: ${formState.phoneCountry}. Tap to change`}
              >
                <span>{formState.phoneCountry}</span>
                <ChevronRight />
              </button>
            </div>
          </div>

          {/* Separator 3: between country and phone number — x=112, width=263 */}
          <Separator inset insetLeft={112} />

          {/* Row 4: Mobile type selector (96px) + Phone number input */}
          <div className="flex">
            <button
              type="button"
              className={[
                'w-[96px] shrink-0 flex items-center justify-between h-[50px]',
                'ps-4 pe-[17px]',
                'bg-white',
                'focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
              ].join(' ')}
              aria-label={`Phone type: ${formState.phoneType}. Tap to change`}
            >
              <span className="text-[16px] font-normal leading-[1.3125em] tracking-[-0.033em] text-blue-ios">
                {formState.phoneType}
              </span>
              <ChevronRight />
            </button>
            <div className="flex-1">
              <input
                type="tel"
                value={formState.phoneNumber}
                onChange={(e) => setFormState((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                aria-label="Phone number"
                className={inputClasses}
              />
            </div>
          </div>
        </div>

        {/* Separator 4: after phone section — x=16, width=359 (nearly full-width) */}
        <Separator inset insetLeft={16} />

        {/* ═══════════ ACTION ROWS ═══════════ */}
        {/* "more fields" expandable link */}
        <button type="button" className={`${actionRowClasses} text-blue-ios`}>
          more fields
        </button>

        {/* "Delete Contact" destructive action */}
        <button
          type="button"
          onClick={handleDelete}
          className={`${actionRowClasses} text-red-ios`}
          aria-label="Delete contact"
        >
          Delete Contact
        </button>
      </form>
    </div>
  );
};

export { EditContact };
export default EditContact;
