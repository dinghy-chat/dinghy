module.exports = {
  name: "Dinghy Chat",
  icon: "./assets/icon.png",
  slug: "dinghy-operator",
  scheme: "dinghy",
  version: "0.1.0",
  userInterfaceStyle: "automatic",
  ios: {
    buildNumber: "11",
    config: { usesNonExemptEncryption: false },
    bundleIdentifier: "chat.dinghy.operator",
    icon: { light: "./assets/icon.png", dark: "./assets/icon.png" },
    supportsTablet: false,
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#ffc917",
      foregroundImage: "./assets/adaptive-foreground.png",
      monochromeImage: "./assets/adaptive-monochrome.png",
    },
    package: "chat.dinghy.operator",
    ...(process.env.GOOGLE_SERVICES_JSON && {
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON,
    }),
  },
  plugins: [
    [
      "expo-splash-screen",
      {
        backgroundColor: "#ffc917",
        image: "./assets/launch-mark.png",
        resizeMode: "contain",
        dark: {
          backgroundColor: "#0b2239",
          image: "./assets/launch-mark-dark.png",
        },
        ios: { imageWidth: 112 },
        android: { imageWidth: 112 },
      },
    ],
    "expo-notifications",
    [
      "expo-image-picker",
      {
        photosPermission: "Allow Dinghy to choose a photo or screenshot for a conversation.",
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
  ],
};
