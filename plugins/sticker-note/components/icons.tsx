// Line icons drawn by the board itself, and the glass sticker mark.
import { useId, type ReactNode } from "react";

const PATHS = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 13h18" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  lines: <path d="M5 7h14M5 12h14M5 17h9" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The plugin's mark: a rounded sticker with a glass highlight and a curled corner. */
export function StickerMark({ className, size }: { className?: string; size?: number }) {
  const id = useId().replace(/:/g, "");
  const fill = `sn-fill-${id}`;
  const gloss = `sn-gloss-${id}`;
  const curl = `sn-curl-${id}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 1px 1.5px rgba(120,70,0,.28))" }}
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe9a3" />
          <stop offset=".55" stopColor="#f9c74f" />
          <stop offset="1" stopColor="#eda226" />
        </linearGradient>
        <linearGradient id={gloss} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity=".04" />
        </linearGradient>
        <linearGradient id={curl} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#fff8dc" />
          <stop offset=".55" stopColor="#ffdc82" />
          <stop offset="1" stopColor="#cf8a10" />
        </linearGradient>
      </defs>
      <path d="M7.2 2.8h9.6a4.4 4.4 0 0 1 4.4 4.4v6.1l-7.9 7.9H7.2a4.4 4.4 0 0 1-4.4-4.4V7.2a4.4 4.4 0 0 1 4.4-4.4z" fill={`url(#${fill})`} />
      <path d="M7.2 2.8h9.6a4.4 4.4 0 0 1 4.4 4.4v1.7c-5.9 2.5-12.4 2.5-18.4.3V7.2a4.4 4.4 0 0 1 4.4-4.4z" fill={`url(#${gloss})`} />
      <path d="M21.2 13.3l-7.9 7.9v-3.3a4.6 4.6 0 0 1 4.6-4.6z" fill={`url(#${curl})`} />
      <path d="M13.3 21.2l7.9-7.9" stroke="#b9770a" strokeOpacity=".35" strokeWidth=".6" />
      <path d="M7.2 3.3h9.6a3.9 3.9 0 0 1 3.9 3.9" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth=".7" strokeLinecap="round" />
    </svg>
  );
}
