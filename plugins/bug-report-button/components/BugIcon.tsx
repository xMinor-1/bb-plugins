// The sidebar bug: the same drawing as icon.svg without the black tile, in the sidebar's own color.
export function BugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="4 4 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.5 11.5a3.5 3.5 0 0 1 7 0" />
      <path d="M13.4 8.6 11.4 6.4M18.6 8.6l2-2.2" />
      <path d="M16 11.5c-4 0-6.5 3-6.5 7s2.7 7 6.5 7 6.5-3 6.5-7-2.5-7-6.5-7z" />
      <path d="M16 11.5v14" />
      <path d="M9.8 15.4 6.6 13.4M9.5 19H5.8M10.4 22.6 7 24.8M22.2 15.4l3.2-2M22.5 19h3.7M21.6 22.6l3.4 2.2" />
    </svg>
  );
}
