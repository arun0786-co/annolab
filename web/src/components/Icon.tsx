// Small 16px line icons drawn with currentColor. Paths are original and kept minimal.
import type { SVGProps } from "react";

const P: Record<string, string> = {
  select: "M3 2l9 5-4 1.2L6.5 13z",
  bbox: "M3 3h10v10H3z",
  polygon: "M3 5l5-3 5 4-2 7H5z",
  point: "M8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8 1v3M8 12v3M1 8h3M12 8h3",
  segment: "M2 4v8M14 4v8M2 8h12",
  track: "M2 10h3v3H2zM11 3h3v3h-3zM5 11.5C8 11 9 6 11 4.5",
  span: "M2 5h12M2 9h8M2 13h10M2 11h8",
  pan: "M8 1v14M1 8h14M8 1l-2 2M8 1l2 2M8 15l-2-2M8 15l2-2M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2",
  zoomIn: "M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l4 4M5 7h4M7 5v4",
  zoomOut: "M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l4 4M5 7h4",
  fit: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
  undo: "M5 4L2 7l3 3M2 7h8a4 4 0 0 1 0 8H7",
  redo: "M11 4l3 3-3 3M14 7H6a4 4 0 0 0 0 8h3",
  eye: "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  eyeOff: "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM2 2l12 12",
  lock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  unlock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0",
  trash: "M3 4h10M6 4V2.5h4V4M4.5 4l.7 10h5.6l.7-10",
  play: "M4 2.5l9 5.5-9 5.5z",
  pause: "M4 2.5h3v11H4zM9 2.5h3v11H9z",
  prev: "M10 3L5 8l5 5",
  next: "M6 3l5 5-5 5",
  keyboard: "M1.5 4h13v8h-13zM4 6.5h1M7 6.5h1M10 6.5h1M5 9.5h6",
  sun: "M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
  image: "M2 3h12v10H2zM2 11l3.5-3.5L9 11l2-2 3 3M10.5 5.5a1 1 0 1 1 0 .01",
  audio: "M2 8h1M4.5 5v6M7 2.5v11M9.5 5.5v5M12 4v8M14 7v2",
  video: "M2 4h9v8H2zM11 7l3-2v6l-3-2",
  text: "M3 3h10M8 3v10M6 13h4",
  download: "M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11",
  upload: "M8 10V2M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11",
  check: "M3 8.5l3 3 7-7",
  x: "M4 4l8 8M12 4l-8 8",
  comment: "M2 3h12v8H7l-3 3v-3H2z",
  wand: "M2 14l8-8M9 3l.5-1.5L10 3l1.5.5L10 4l-.5 1.5L9 4l-1.5-.5zM12.5 7l.4-1 .4 1 1 .4-1 .4-.4 1-.4-1-1-.4z",
  search: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.5 10.5L14 14",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  skip: "M3 3l6 5-6 5zM11 3v10",
  logout: "M6 2H3v12h3M10 5l3 3-3 3M13 8H6",
  settings: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3",
  key: "M5.5 7a2.5 2.5 0 1 1 0 .01M7.5 8.5L14 8.5M12 8.5v2M14 8.5v2",
  flag: "M3 14V2M3 2.5h9l-2 3 2 3H3",
  layers: "M8 2l6 3.5L8 9 2 5.5zM2 8.5L8 12l6-3.5M2 11.5L8 15l6-3.5",
  repeat: "M2 7V5.5A2.5 2.5 0 0 1 4.5 3H13M11 1l2 2-2 2M14 9v1.5A2.5 2.5 0 0 1 11.5 13H3M5 15l-2-2 2-2",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={P[name]} />
    </svg>
  );
}

export const MODALITY_ICON: Record<string, IconName> = { image: "image", audio: "audio", video: "video", text: "text" };
