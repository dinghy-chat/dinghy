import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { type DinghyApi, MAX_PROFILE_IMAGE_BYTES } from "./api";
import { Avatar, readableError } from "./common";
import { fonts } from "./fonts";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
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
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (visible) {
      setName(me.name);
      setError("");
    }
  }, [visible, me.name]);
  async function change(operation: () => Promise<Partial<Me>>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onSaved({ ...me, ...(await operation()) });
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  }
  const choosePhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.78,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (result.canceled) return {};
    const asset = result.assets[0];
    if (!asset) return {};
    if ((asset.fileSize ?? 0) > MAX_PROFILE_IMAGE_BYTES) throw new Error(t("pictureTooLarge"));
    return await api.updatePicture({ uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg" });
  };
  const remove = () =>
    Alert.alert(t("pictureRemove"), undefined, [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("pictureRemove"),
        style: "destructive",
        onPress: () => void change(() => api.removePicture()),
      },
    ]);
  const dirty = name.trim().length > 0 && name.trim() !== me.name;
  function saveName() {
    if (!dirty || busy) return;
    Keyboard.dismiss();
    void change(async () => {
      const next = name.trim();
      await api.updateName(next);
      return { name: next };
    });
  }
  return (
    <Sheet
      visible={visible}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("pageProfile")}
      palette={palette}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
        <View style={s.identity}>
          <Avatar name={me.name} picture={me.pictureUrl} size={76} palette={palette} />
          <View style={s.identityText}>
            <Text style={[s.name, { color: palette.ink }]}>{me.name}</Text>
            <Text selectable style={[s.email, { color: palette.sub }]}>
              {me.email}
            </Text>
          </View>
        </View>
        <View style={s.photoActions}>
          <Pressable
            disabled={busy}
            accessibilityRole="button"
            onPress={() => void change(choosePhoto)}
            style={[s.photoButton, { backgroundColor: palette.wash }]}
          >
            <Text style={[s.photoText, { color: palette.blue }]}>
              {t(me.pictureUrl ? "pictureReplace" : "pictureUpload")}
            </Text>
          </Pressable>
          {me.pictureUrl && (
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              onPress={remove}
              style={s.photoButton}
            >
              <Text style={[s.photoText, { color: palette.sub }]}>{t("pictureRemove")}</Text>
            </Pressable>
          )}
        </View>
        <Text style={[s.label, { color: palette.ink }]}>{t("accountName")}</Text>
        <TextInput
          accessibilityLabel={t("accountName")}
          autoComplete="name"
          returnKeyType="go"
          onSubmitEditing={saveName}
          editable={!busy}
          value={name}
          onChangeText={setName}
          style={[s.input, { backgroundColor: palette.wash, color: palette.ink }]}
        />
        {error && (
          <Text accessibilityRole="alert" style={[s.email, { color: palette.amber }]}>
            {error}
          </Text>
        )}
        <Pressable
          disabled={!dirty || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !dirty || busy }}
          onPress={saveName}
          style={[s.save, { backgroundColor: dirty ? palette.blue : palette.wash }]}
        >
          {busy ? (
            <ActivityIndicator color={palette.sub} />
          ) : (
            <Text style={[s.photoText, { color: dirty ? palette.onBlue : palette.sub }]}>
              {t("save")}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </Sheet>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 22, paddingBottom: 8, gap: 12 },
  identity: { flexDirection: "row", alignItems: "center", gap: 16, paddingTop: 6 },
  identityText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.bold, fontSize: 20 },
  email: { fontFamily: fonts.body, fontSize: 15 },
  photoActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 5,
    paddingBottom: 10,
  },
  photoButton: { minHeight: 44, borderRadius: 22, paddingHorizontal: 15, justifyContent: "center" },
  photoText: { fontFamily: fonts.semibold, fontSize: 15 },
  label: { fontFamily: fonts.semibold, fontSize: 15 },
  input: {
    fontFamily: fonts.body,
    fontSize: 17,
    minHeight: 48,
    borderRadius: 24,
    paddingHorizontal: 18,
  },
  save: { minHeight: 48, borderRadius: 24, justifyContent: "center", alignItems: "center" },
});
