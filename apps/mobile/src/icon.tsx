import Svg, { Path } from "react-native-svg";

const paths = {
  server: "M4 4h16v6H4z M4 14h16v6H4z M7 7h1 M7 17h1",
  addressBook:
    "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5z M3 7h3m-3 5h3m-3 5h3 M15.5 9a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0 M8.5 17a4.5 4.5 0 0 1 9 0",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18z",
  chart: "M2 20h20 M4 20v-7h4v7 M10 20V9h4v11 M16 20V4h4v16",
  profileTab:
    "M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z M15.2 9a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 1 1 6.4 0z M5.8 19.5a6.4 6.4 0 0 1 12.4 0",
  back: "m14 5-7 7 7 7",
  androidBack: "M20 12H4m7-7-7 7 7 7",
  next: "m9 6 6 6-6 6",
  down: "m6 9 6 6 6-6",
  more: "M4 12h.3m7.4 0h.3m7.4 0h.3",
  vertical: "M12 4v.3m0 7.4v.3m0 7.4v.3",
  inbox: "M3 13l3-8h12l3 8v7H3z M3 13h5l2 3h4l2-3h5",
  people:
    "M2 20v-2a5 5 0 0 1 10 0v2 M11 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0 M15 13a5 5 0 0 1 6 5v2 M15 3a4 4 0 0 1 0 8",
  settings: "M4 6h8m4 0h4M4 12h2m4 0h10M4 18h11m4 0h1 M12 4v4 M7 10v4 M16 16v4",
  search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 1 1 16 0",
  check: "m4 12 5 5L20 6",
  done: "M20 12a8 8 0 1 1-5-7 M8 11l4 4 8-9",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M12 6v6l4 2",
  person: "M4 21v-1a8 8 0 0 1 16 0v1 M16 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0",
  hand: "M3 7h15m-4-4 4 4-4 4 M21 17H6m4-4-4 4 4 4",
  bot: "M5 7h14v13H5z M12 7V3 M8 12h1m6 0h1 M9 16h6",
  lock: "M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3",
  send: "M12 20V5m-6 6 6-6 6 6",
  plus: "M5 12h14m-7-7v14",
  chat: "M3 4h18v13H9l-6 4z",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  x: "m6 6 12 12M18 6 6 18",
  tag: "M3 3h9l9 9-9 9-9-9z M7 7h.1",
  filter: "M3 6h18M6 12h12M9 18h6",
  dots: "M5 12h.2m6 0h.2m6 0h.2",
  pause: "M8 4v16 M16 4v16",
  mail: "M3 5h18v14H3z M3 6l9 7 9-7",
  bell: "M3 17h18l-3-4V9a6 6 0 0 0-12 0v4z M10 20h4",
  file: "M5 3h9l5 5v13H5z M14 3v6h5",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  play: "m7 4 13 8-13 8z",
  attach: "m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10",
} as const;

export function Icon({
  name,
  size = 20,
  filled = false,
  color,
}: {
  name: keyof typeof paths;
  size?: number;
  filled?: boolean;
  color: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={
          filled && name === "inbox"
            ? "M5 4h14l3 10v6H2v-6z M4.7 13H9l1.5 3h3l1.5-3h4.3L17.5 6h-11z"
            : paths[name]
        }
        fill={filled && name === "inbox" ? color : "none"}
        fillRule="evenodd"
        stroke={color}
        strokeWidth={name === "more" || name === "vertical" ? 3.2 : filled ? 2.2 : 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
