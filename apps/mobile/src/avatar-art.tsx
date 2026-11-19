import Svg, { Circle, Path, Rect } from "react-native-svg";

const colors = [
  ["#68A8B4", "#194253", "#E0F2E9"],
  ["#DC9165", "#513749", "#FFE4BD"],
  ["#B3A7D2", "#53456A", "#F1DCF0"],
  ["#9BBE9B", "#28574F", "#F5EDC6"],
  ["#E3AE83", "#693D43", "#FFECD8"],
  ["#80AADD", "#254469", "#DFEAF9"],
] as const;

export function AvatarArt({
  name,
  size,
  workspace,
}: {
  name: string;
  size: number;
  workspace: boolean;
}) {
  let seed = 0;
  for (const ch of name.toLowerCase()) seed = (Math.imul(31, seed) + ch.charCodeAt(0)) >>> 0;
  const [base, ink, light] = colors[seed % colors.length] ?? colors[0];
  const flip = ((seed >>> 3) & 1) === 0;
  return (
    <Svg accessible={false} viewBox="0 0 40 40" width={size} height={size}>
      <Rect width="40" height="40" fill={base} />
      {workspace ? (
        <>
          <Path d={flip ? "M0 0h40L0 40z" : "M0 40l40-40v40z"} fill={ink} />
          <Path
            d={flip ? "M5 31 18 9v22z M21 9l13 22H21z" : "M4 27 14 9l10 18z M16 31 27 12l10 19z"}
            fill={light}
          />
        </>
      ) : (
        <>
          <Circle cx={flip ? 16 : 23} cy="36" r="14" fill={ink} />
          <Circle cx={flip ? 18 : 22} cy="16" r="7" fill={light} />
          <Path
            d={flip ? "M10 15a8 8 0 0 1 16-1l-5-2-4 4z" : "M14 14a8 8 0 0 1 16 1l-5-3-4 2z"}
            fill={ink}
          />
        </>
      )}
    </Svg>
  );
}
