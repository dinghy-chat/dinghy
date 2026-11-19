import { StyleSheet } from "react-native";

export const controlShape = { pill: 999 } as const;

export const day = {
  ink: "#122a36",
  sub: "#586a73",
  paper: "#fdfefd",
  wash: "#f1f4f4",
  line: "#dce4e3",
  blue: "#084f9d",
  onBlue: "#ffffff",
  tint: "#e7f0fa",
  warm: "#fff0cd",
  amber: "#80500b",
  note: "#fff4cd",
  noteInk: "#624710",
  navy: "#163746",
  green: "#167052",
  sheet: "#ffffff",
  scrim: "rgba(6, 20, 31, 0.42)",
  authPanel: "#fffdf7",
  authInk: "#112e3b",
  authLine: "#c8d7d6",
};

export type Palette = typeof day;

export const night: Palette = {
  ink: "#e9f1f2",
  sub: "#b2c0c5",
  paper: "#14232c",
  wash: "#24343d",
  line: "#33444d",
  blue: "#a6cfff",
  onBlue: "#14232c",
  tint: "#26445e",
  warm: "#423720",
  amber: "#f2c16f",
  note: "#493d22",
  noteInk: "#ffe7aa",
  navy: "#daeaf0",
  green: "#66d8a3",
  sheet: "#2a3c48",
  scrim: "rgba(0, 6, 13, 0.73)",
  authPanel: "#172d3c",
  authInk: "#eef5f6",
  authLine: "#47606c",
};

export const styles = StyleSheet.create({
  app: { flex: 1 },
  mainPage: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  avatar: { alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 15, fontWeight: "700" },
  errorBanner: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  errorBannerText: { flex: 1, color: "#ffffff", fontSize: 13, lineHeight: 18 },
  errorDismiss: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
    textDecorationLine: "underline",
  },
});
