import { Image, StyleSheet, View } from "react-native";
import Svg, { G, Path, Rect } from "react-native-svg";

const inboxDay = require("./assets/inbox-day.png");
const inboxNight = require("./assets/inbox-night.png");

const dayColors = {
  sky: "#dcefeb",
  highSky: "#cce7e5",
  cloud: "#fff8df",
  sun: "#ffc859",
  farShore: "#a9ceca",
  middleShore: "#7eaaa9",
  nearShore: "#476f78",
  water: "#84bec6",
  farWater: "#add5d4",
  deepWater: "#4f8f9e",
  glint: "#d7efea",
  ink: "#173746",
  sail: "#fff3cf",
  red: "#d8523d",
  redLight: "#f07a55",
  lamp: "#ffe093",
} as const;

type HarborColors = { [Key in keyof typeof dayColors]: string };

const nightColors: HarborColors = {
  sky: "#112b42",
  highSky: "#0b2137",
  cloud: "#456475",
  sun: "#ffe39b",
  farShore: "#355b6c",
  middleShore: "#294d60",
  nearShore: "#17394c",
  water: "#28586c",
  farWater: "#396d7c",
  deepWater: "#173f55",
  glint: "#8fb9b5",
  ink: "#0a2235",
  sail: "#ffe8bd",
  red: "#e26046",
  redLight: "#f28a60",
  lamp: "#ffd980",
};

function SkyDetails({ colors, night }: { colors: HarborColors; night: boolean }) {
  if (night) {
    return (
      <G fill={colors.cloud}>
        <Rect x={28} y={39} width={3} height={3} />
        <Rect x={67} y={63} width={2} height={2} />
        <Rect x={107} y={31} width={3} height={3} />
        <Rect x={148} y={54} width={2} height={2} />
        <Rect x={193} y={27} width={2} height={2} />
        <Rect x={317} y={47} width={3} height={3} />
        <Rect x={336} y={79} width={2} height={2} />
        <Path fill={colors.sun} d="M292 34h12v4h4v16h-4v4h-12v-4h-4V38h4z" />
        <Rect x={300} y={34} width={8} height={20} fill={colors.sky} />
      </G>
    );
  }
  return (
    <G>
      <Path fill={colors.sun} d="M290 31h22v5h5v22h-5v5h-22v-5h-5V36h5z" />
      <G fill={colors.cloud}>
        <Path d="M37 55h10v-5h16v5h9v6H37z" />
        <Path d="M143 36h9v-5h13v5h11v6h-33z" />
        <Path d="M292 83h11v-6h15v6h13v6h-39z" />
      </G>
      <G fill={colors.middleShore}>
        <Rect x={95} y={60} width={8} height={2} />
        <Rect x={105} y={56} width={7} height={2} />
        <Rect x={114} y={59} width={8} height={2} />
      </G>
    </G>
  );
}

function Lighthouse({ colors }: { colors: HarborColors }) {
  return (
    <G>
      <Path fill={colors.nearShore} d="M0 151h23l13-8 14 5 12 3v13H0z" />
      <Rect x={29} y={107} width={18} height={43} fill={colors.sail} />
      <Rect x={29} y={119} width={18} height={9} fill={colors.red} />
      <Rect x={29} y={139} width={18} height={8} fill={colors.red} />
      <Rect x={27} y={102} width={22} height={6} fill={colors.ink} />
      <Rect x={31} y={96} width={14} height={7} fill={colors.lamp} />
      <Rect x={35} y={90} width={6} height={6} fill={colors.ink} />
      <Rect x={25} y={149} width={26} height={4} fill={colors.ink} />
      <Rect x={36} y={130} width={5} height={7} fill={colors.ink} />
    </G>
  );
}

function Sailboat({ colors }: { colors: HarborColors }) {
  return (
    <G>
      <G fill={colors.glint} opacity={0.82}>
        <Rect x={207} y={206} width={61} height={4} />
        <Rect x={218} y={216} width={42} height={3} />
        <Rect x={228} y={225} width={24} height={3} />
        <Rect x={232} y={234} width={16} height={2} />
      </G>
      <Rect x={229} y={91} width={6} height={91} fill={colors.ink} />
      <Path fill={colors.sail} d="M225 101v64h-51l8-9 35-50z" />
      <Path fill={colors.red} d="M240 101v64h43l-7-11-28-45z" />
      <Path fill={colors.redLight} d="M240 101v13l36 50h7l-7-11-28-45z" />
      <Rect x={180} y={159} width={45} height={6} fill={colors.cloud} opacity={0.72} />
      <Rect x={240} y={159} width={38} height={6} fill={colors.sail} opacity={0.66} />
      <Path fill={colors.ink} d="M164 173h129l-7 18-12 9h-84l-15-9z" />
      <Path fill={colors.sail} d="M170 177h117l-4 7H176z" />
      <Rect x={193} y={191} width={80} height={5} fill={colors.red} />
      <Rect x={234} y={83} width={22} height={7} fill={colors.red} />
      <Rect x={234} y={90} width={14} height={4} fill={colors.redLight} />
      <Rect x={208} y={184} width={8} height={5} fill={colors.ink} />
      <Rect x={229} y={184} width={8} height={5} fill={colors.ink} />
      <Rect x={250} y={184} width={8} height={5} fill={colors.ink} />
    </G>
  );
}

function SignInHarbor({ night }: { night: boolean }) {
  const colors = night ? nightColors : dayColors;
  return (
    <View pointerEvents="none" accessible={false} style={styles.scene}>
      <Svg height="100%" width="100%" viewBox="0 0 600 260" preserveAspectRatio="xMidYMax slice">
        <Rect width={600} height={260} fill={colors.sky} />
        <Rect width={600} height={76} fill={colors.highSky} />
        <Path
          fill={colors.farShore}
          d="M0 137l44-24 36 14 42-23 39 19 48-31 43 36 47-18 51 22 46-34 50 38 48-22 46 18 50-25 40 25v36H0z"
        />
        <Path
          fill={colors.middleShore}
          d="M0 151l41-13 39 12 42-19 35 13 44-17 42 27 42-9 45 15 43-20 44 13 48-18 41 22 48-14 66 17v18H0z"
        />
        <Rect y={158} width={600} height={102} fill={colors.water} />
        <Path fill={colors.farWater} d="M0 158h600v21H0z" opacity={0.68} />
        <Path fill={colors.deepWater} d="M0 236h600v24H0z" opacity={0.5} />
        <G transform="translate(120 0)">
          <SkyDetails colors={colors} night={night} />
          <Path
            fill={colors.farShore}
            d="M0 137l24-12 18 5 20-17 18 9 25-27 24 22 25-11 24 18 25-28 27 27 25-15 23 17 30-31 33 29 23-8 30 22v30H0z"
          />
          <Path
            fill={colors.middleShore}
            d="M0 150l28-9 20 7 28-15 20 7 31-11 29 22 24-5 29 10 25-17 27 9 28-16 28 17 25-9 38 14v19H0z"
          />
          <Lighthouse colors={colors} />
          <G fill={colors.glint} opacity={night ? 0.62 : 0.84}>
            <Rect x={10} y={178} width={27} height={3} />
            <Rect x={50} y={194} width={21} height={3} />
            <Rect x={87} y={171} width={34} height={4} />
            <Rect x={105} y={205} width={19} height={3} />
            <Rect x={20} y={221} width={42} height={3} />
            <Rect x={75} y={241} width={27} height={3} />
            <Rect x={302} y={183} width={35} height={3} />
            <Rect x={318} y={216} width={24} height={3} />
            <Rect x={287} y={242} width={47} height={3} />
          </G>
          <G fill={colors.deepWater} opacity={0.76}>
            <Rect x={71} y={183} width={23} height={3} />
            <Rect x={126} y={191} width={30} height={3} />
            <Rect x={16} y={207} width={21} height={3} />
            <Rect x={131} y={226} width={38} height={3} />
            <Rect x={302} y={199} width={20} height={3} />
            <Rect x={265} y={222} width={28} height={3} />
            <Rect x={105} y={250} width={51} height={3} />
          </G>
          <Sailboat colors={colors} />
          <G fill={colors.ink}>
            <Rect x={0} y={244} width={74} height={8} />
            <Rect x={0} y={252} width={92} height={8} />
            <Rect x={20} y={226} width={7} height={34} />
            <Rect x={64} y={232} width={7} height={28} />
            <Rect x={9} y={238} width={73} height={5} />
          </G>
        </G>
      </Svg>
    </View>
  );
}

export function Harbor({
  night,
  variant = "banner",
}: {
  night: boolean;
  variant?: "banner" | "sign-in";
}) {
  if (variant === "sign-in") return <SignInHarbor night={night} />;
  return (
    <Image
      accessible={false}
      source={night ? inboxNight : inboxDay}
      resizeMode="stretch"
      style={styles.inbox}
    />
  );
}

const styles = StyleSheet.create({
  scene: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  inbox: { position: "absolute", width: "100%", height: "100%" },
});
