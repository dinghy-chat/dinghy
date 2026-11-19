import { Image, StyleSheet } from "react-native";

const inboxDay = require("./assets/inbox-day.png");
const inboxNight = require("./assets/inbox-night.png");

export function Harbor({ night }: { night: boolean }) {
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
  inbox: { position: "absolute", width: "100%", height: "100%" },
});
