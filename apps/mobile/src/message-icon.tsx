import Svg, { Circle, Path } from "react-native-svg";

const paths = {
  reply: "M9 8 4 12l5 4M5 12h8a6 6 0 0 1 6 6",
  copy: "M9 9h11v11H9z M4 15V4h11",
  edit: "m4 20 4-1 11-11-3-3L5 16z M14 7l3 3",
  info: "M12 11v6 M12 7h.01",
  link: "M10 14 14 10 M8 16H6a4 4 0 0 1 0-8h4 M16 8h2a4 4 0 0 1 0 8h-4",
  trash: "M4 7h16 M9 7V4h6v3 M7 7l1 14h8l1-14 M10 11v6 M14 11v6",
  checks: "m3 12 4 4 8-9 M10 15l2 2 9-10",
  swipe: "M5 12h14 M9 8l-4 4 4 4",
} as const;

export type MessageIconName = keyof typeof paths;

export function MessageIcon({
  name,
  color,
  size = 20,
}: {
  name: MessageIconName;
  color: string;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={paths[name]}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.7}
      />
      {name === "info" && (
        <Circle cx={12} cy={12} r={9} fill="none" stroke={color} strokeWidth={1.7} />
      )}
    </Svg>
  );
}
