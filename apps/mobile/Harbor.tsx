import { Image, StyleSheet } from "react-native";
import Svg, { Defs, Path, Pattern, Rect } from "react-native-svg";
import { MovingPatch } from "./src/scene-motion";

const inboxDay = require("./assets/inbox-day.png");
const inboxNight = require("./assets/inbox-night.png");
const boatDay = require("./assets/inbox-boat-day.png");
const boatNight = require("./assets/inbox-boat-night.png");

/** The harbor art. Only the Inbox header sets `moving`, so the boat bobs there and nowhere else. */
export function Harbor({
  night,
  shore,
  moving = false,
}: {
  night: boolean;
  shore?: string;
  moving?: boolean;
}) {
  return (
    <>
      <Image
        accessible={false}
        source={night ? inboxNight : inboxDay}
        resizeMode="stretch"
        style={styles.inbox}
      />
      {moving && <MovingPatch name="inbox" source={night ? boatNight : boatDay} />}
      {shore && (
        <Svg accessible={false} width="100%" height={9} style={styles.shore}>
          <Defs>
            {/* Last three 3 pt pixel rows of the shoreline in render-header-scenes.ts. */}
            <Pattern id="shore" width={105} height={9} patternUnits="userSpaceOnUse">
              <Path d="M0 0h9v3h24v3h30V3h21V0h21v9H0Z" fill={shore} />
            </Pattern>
          </Defs>
          <Rect width="100%" height={9} fill="url(#shore)" />
        </Svg>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  inbox: { position: "absolute", width: "100%", height: "100%" },
  shore: { position: "absolute", bottom: 0, left: 0 },
});
