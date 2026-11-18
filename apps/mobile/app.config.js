module.exports = {
  name: "Dinghy",
  icon: "./assets/icon.png",
  slug: "dinghy-operator",
  scheme: "dinghy",
  version: "0.1.0",
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: "chat.dinghy.operator", supportsTablet: false },
  android: {
    package: "chat.dinghy.operator",
    ...(process.env.GOOGLE_SERVICES_JSON && {
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON,
    }),
  },
  plugins: ["expo-notifications", "expo-secure-store", "expo-sqlite"],
};
