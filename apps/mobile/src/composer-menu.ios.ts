import { ActionSheetIOS } from "react-native";
import { t } from "../../operator/src/text.ts";
import type { ComposerAction } from "./composer-menu";

export function openComposerMenu(actions: readonly ComposerAction[], _openSheet: () => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options: [...actions.map((action) => action.label), t("cancel")],
      cancelButtonIndex: actions.length,
    },
    (index) => actions[index]?.run(),
  );
}
