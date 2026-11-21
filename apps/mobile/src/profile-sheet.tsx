import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  // biome-ignore lint/correctness/useReactNativePlatformComponents: only called when Platform.OS is "ios".
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { type DinghyApi, MAX_PROFILE_IMAGE_BYTES } from "./api";
import { Avatar, readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { Sheet } from "./sheet";
import { night, type Palette } from "./theme";
import type { Me } from "./types";

export function ProfileSheet({
  visible,
  onClose,
  api,
  me,
  palette,
  onSaved,
}: {
  visible: boolean;
  onClose(): void;
  api: DinghyApi;
  me: Me;
  palette: Palette;
  onSaved(me: Me): void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 270;
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState<"photo" | "name" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (visible) {
      setName(me.name);
      setError("");
    }
  }, [visible, me.name]);
  async function change(kind: "photo" | "name", operation: () => Promise<Partial<Me>>) {
    if (busy) return false;
    setBusy(kind);
    setError("");
    try {
      onSaved({ ...me, ...(await operation()) });
      return true;
    } catch (failure) {
      setError(readableError(failure));
      return false;
    } finally {
      setBusy(null);
    }
  }
  const choosePhoto = () =>
    void change("photo", async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.78,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset) return {};
      if ((asset.fileSize ?? 0) > MAX_PROFILE_IMAGE_BYTES) throw new Error(t("pictureTooLarge"));
      return await api.updatePicture({ uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg" });
    });
  const removePhoto = () => void change("photo", () => api.removePicture());
  // One control for the photo. With no photo there is nothing to remove, so it opens the library.
  function changePhoto() {
    if (busy) return;
    Keyboard.dismiss();
    if (!me.pictureUrl) return choosePhoto();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [t("mobileChoosePhoto"), t("mobileRemovePhoto"), t("cancel")],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
          userInterfaceStyle: palette === night ? "dark" : "light",
        },
        (index) => {
          if (index === 0) choosePhoto();
          if (index === 1) removePhoto();
        },
      );
      return;
    }
    Alert.alert(t("mobileChangePhoto"), undefined, [
      { text: t("cancel"), style: "cancel" },
      { text: t("mobileRemovePhoto"), style: "destructive", onPress: removePhoto },
      { text: t("mobileChoosePhoto"), onPress: choosePhoto },
    ]);
  }
  const next = name.trim();
  const dirty = next.length > 0 && next !== me.name;
  function cancel() {
    if (busy) return;
    Keyboard.dismiss();
    onClose();
  }
  async function save() {
    if (!dirty || busy) return;
    Keyboard.dismiss();
    const saved = await change("name", async () => {
      await api.updateName(next);
      return { name: next };
    });
    if (saved) onClose();
  }
  const title = (
    <Text
      accessibilityRole="header"
      style={[s.barTitle, stacked && s.stackedTitle, { color: palette.ink }]}
    >
      {t("mobileEditProfile")}
    </Text>
  );
  const photoLabel = t(me.pictureUrl ? "mobileChangePhoto" : "mobileAddPhoto");
  return (
    <Sheet visible={visible} onClose={cancel} dismissible={!busy} palette={palette}>
      <View style={[s.bar, stacked && s.spread]}>
        <Pressable
          accessibilityRole="button"
          disabled={busy !== null}
          hitSlop={6}
          onPress={cancel}
          style={({ pressed }) => [s.barButton, pressed && s.pressed]}
        >
          <Text style={[s.barText, { color: palette.blue }]}>{t("cancel")}</Text>
        </Pressable>
        {!stacked && title}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !dirty || busy !== null, busy: busy === "name" }}
          disabled={!dirty || busy !== null}
          hitSlop={6}
          onPress={() => void save()}
          style={({ pressed }) => [s.barButton, s.barEnd, pressed && s.pressed]}
        >
          {busy === "name" ? (
            <ActivityIndicator color={palette.blue} />
          ) : (
            <Text style={[s.barText, s.barSave, { color: dirty ? palette.blue : palette.sub }]}>
              {t("save")}
            </Text>
          )}
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={s.body}
      >
        {stacked && title}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={photoLabel}
          accessibilityState={{ disabled: busy !== null, busy: busy === "photo" }}
          disabled={busy !== null}
          onPress={changePhoto}
          style={({ pressed }) => [s.photo, pressed && s.pressed]}
        >
          <View>
            <Avatar name={me.name} picture={me.pictureUrl} size={96} palette={palette} />
            {busy === "photo" && (
              <View style={[s.photoBusy, { backgroundColor: palette.scrim }]}>
                <ActivityIndicator color="#ffffff" />
              </View>
            )}
            <View style={[s.badge, { backgroundColor: palette.blue, borderColor: palette.sheet }]}>
              <Icon name="pencil" size={15} color={palette.onBlue} />
            </View>
          </View>
          <Text style={[s.photoText, { color: palette.blue }]}>{photoLabel}</Text>
        </Pressable>
        <View style={[s.card, { backgroundColor: palette.wash }]}>
          <View style={[s.row, stacked && s.stackedRow]}>
            <Text style={[s.rowLabel, stacked && s.autoWidth, { color: palette.ink }]}>
              {t("accountName")}
            </Text>
            <TextInput
              accessibilityLabel={t("accountName")}
              autoCapitalize="words"
              autoComplete="name"
              autoCorrect={false}
              clearButtonMode="while-editing"
              editable={busy !== "name"}
              enterKeyHint="done"
              onChangeText={setName}
              onSubmitEditing={() => void save()}
              returnKeyType="done"
              selectionColor={palette.blue}
              style={[s.rowValue, s.input, stacked && s.stackedValue, { color: palette.ink }]}
              textContentType="name"
              value={name}
            />
          </View>
          <View style={[s.divider, { backgroundColor: palette.line }]} />
          <View
            accessible
            accessibilityLabel={`${t("email")}, ${t("mobileEmailLocked", { email: me.email })}`}
            style={[s.row, stacked && s.stackedRow]}
          >
            <Text style={[s.rowLabel, stacked && s.autoWidth, { color: palette.ink }]}>
              {t("email")}
            </Text>
            <Text
              numberOfLines={stacked ? undefined : 1}
              style={[s.rowValue, stacked && s.stackedValue, { color: palette.sub }]}
            >
              {me.email}
            </Text>
            <View style={stacked && s.stackedLock}>
              <Icon name="lock" size={16} color={palette.sub} />
            </View>
          </View>
        </View>
        {error !== "" && (
          <Text accessibilityRole="alert" style={[s.note, { color: palette.danger }]}>
            {error}
          </Text>
        )}
        <Text style={[s.note, { color: palette.sub }]}>{t("mobileProfileFootnote")}</Text>
      </ScrollView>
    </Sheet>
  );
}

const s = StyleSheet.create({
  bar: {
    minHeight: 48,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  spread: { justifyContent: "space-between" },
  stackedTitle: { flex: 0, textAlign: "left" },
  stackedRow: { flexDirection: "column", alignItems: "stretch", gap: 3, paddingVertical: 10 },
  autoWidth: { width: "auto" },
  stackedValue: { flex: 0 },
  stackedLock: { position: "absolute", right: 16, top: 18 },
  barButton: { minWidth: 72, minHeight: 44, paddingHorizontal: 12, justifyContent: "center" },
  barEnd: { alignItems: "flex-end" },
  barText: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 22 },
  barSave: { fontFamily: fonts.semibold },
  barTitle: {
    flex: 1,
    textAlign: "center",
    fontFamily: fonts.semibold,
    fontSize: 17,
    lineHeight: 22,
  },
  pressed: { opacity: 0.6 },
  body: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 12 },
  photo: { alignSelf: "center", alignItems: "center", gap: 10, paddingBottom: 10 },
  photoBusy: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2.5,
    alignItems: "center",
    justifyContent: "center",
  },
  photoText: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21 },
  card: { borderRadius: 14, overflow: "hidden" },
  row: {
    minHeight: 50,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowLabel: { width: 64, fontFamily: fonts.medium, fontSize: 16, lineHeight: 21 },
  rowValue: { flex: 1, minWidth: 0, fontFamily: fonts.body, fontSize: 16, lineHeight: 21 },
  input: { minHeight: 50, paddingVertical: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  note: { paddingHorizontal: 16, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 18 },
});
