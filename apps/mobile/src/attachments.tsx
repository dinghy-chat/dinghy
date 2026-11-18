import { randomUUID } from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { t } from "../../operator/src/text.ts";
import { type DinghyApi, MAX_IMAGE_BYTES } from "./api";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import type { Palette } from "./theme";
import type { Message, MessageAttachment, PhotoUpload } from "./types";

type PickedPhoto = PhotoUpload & {
  name: string;
  size: number | null;
  width: number;
  height: number;
};

function pickedMimeType(asset: ImagePicker.ImagePickerAsset): string {
  const reported = asset.mimeType?.toLowerCase();
  if (reported === "image/jpg") return "image/jpeg";
  if (reported === "image/png" || reported === "image/jpeg" || reported === "image/webp") {
    return reported;
  }
  const path = `${asset.fileName ?? ""} ${asset.uri}`.toLowerCase();
  if (/\.png(?:\?|$|\s)/.test(path)) return "image/png";
  if (/\.webp(?:\?|$|\s)/.test(path)) return "image/webp";
  return "image/jpeg";
}

function sizeLabel(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PhotoComposerButton({
  api,
  bottomInset,
  conversationId,
  disabled = false,
  onError,
  onSent,
  palette,
}: {
  api: DinghyApi;
  bottomInset: number;
  conversationId: string;
  disabled?: boolean;
  onError(error: unknown): void;
  onSent(message: Message): void | Promise<void>;
  palette: Palette;
}) {
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);

  const close = () => {
    if (sending) return;
    setPhoto(null);
    setClientId(null);
    setSendFailed(false);
  };

  const pick = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        allowsMultipleSelection: false,
        mediaTypes: ["images"],
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        quality: 1,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (asset.fileSize !== undefined && asset.fileSize > MAX_IMAGE_BYTES) {
        onError(new Error(t("imageTooLarge")));
        return;
      }
      setPhoto({
        uri: asset.uri,
        mimeType: pickedMimeType(asset),
        name: asset.fileName || t("image"),
        size: asset.fileSize ?? null,
        width: asset.width,
        height: asset.height,
      });
      setClientId(randomUUID());
      setSendFailed(false);
    } catch (failure) {
      onError(failure);
    }
  };

  const send = async () => {
    if (!photo || !clientId || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      const message = await api.uploadPhoto(conversationId, clientId, photo);
      await onSent(message);
      close();
    } catch (failure) {
      setSendFailed(true);
      onError(failure);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityLabel={t("mobileAttachPhoto")}
        accessibilityRole="button"
        disabled={disabled}
        hitSlop={6}
        onPress={() => void pick()}
        style={({ pressed }) => [
          attachmentStyles.composeButton,
          {
            backgroundColor: pressed ? palette.tint : palette.paper,
            borderColor: palette.line,
            opacity: disabled ? 0.4 : 1,
          },
        ]}
      >
        <Icon color={palette.blue} name="attach" size={15} />
        <Text
          style={{ color: palette.ink, fontFamily: fonts.medium, fontSize: 12, lineHeight: 16 }}
        >
          {t("mobilePhotoTool")}
        </Text>
      </Pressable>
      <Modal
        animationType="slide"
        onRequestClose={close}
        presentationStyle="overFullScreen"
        transparent
        visible={photo !== null}
      >
        <View style={attachmentStyles.sheetRoot}>
          <Pressable
            accessibilityLabel={t("mobileDismiss")}
            disabled={sending}
            onPress={close}
            style={attachmentStyles.backdrop}
          />
          {photo && (
            <View
              accessibilityViewIsModal
              style={[
                attachmentStyles.sheet,
                {
                  backgroundColor: palette.paper,
                  paddingBottom: Math.max(bottomInset, 12),
                },
              ]}
            >
              <View style={attachmentStyles.sheetHead}>
                <Text
                  style={[
                    attachmentStyles.sheetTitle,
                    { color: palette.ink, fontFamily: fonts.display },
                  ]}
                >
                  {t("mobilePhotoPreview")}
                </Text>
                <Pressable
                  accessibilityLabel={t("mobileDismiss")}
                  accessibilityRole="button"
                  disabled={sending}
                  onPress={close}
                  style={attachmentStyles.closeButton}
                >
                  <Icon color={palette.ink} name="x" size={20} />
                </Pressable>
              </View>
              <Image
                accessibilityLabel={t("imageAlt")}
                resizeMode="contain"
                source={{ uri: photo.uri }}
                style={[attachmentStyles.pickedImage, { backgroundColor: palette.wash }]}
              />
              <View style={attachmentStyles.photoMeta}>
                <Text
                  numberOfLines={1}
                  style={[
                    attachmentStyles.photoName,
                    { color: palette.ink, fontFamily: fonts.medium },
                  ]}
                >
                  {photo.name}
                </Text>
                {sizeLabel(photo.size) && (
                  <Text style={{ color: palette.sub, fontFamily: fonts.body, fontSize: 12 }}>
                    {sizeLabel(photo.size)}
                  </Text>
                )}
              </View>
              {sendFailed && (
                <Text
                  accessibilityRole="alert"
                  style={[
                    attachmentStyles.sendError,
                    { color: palette.sub, fontFamily: fonts.body },
                  ]}
                >
                  {t("mobilePhotoSendFailed")}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={sending}
                onPress={() => void send()}
                style={({ pressed }) => [
                  attachmentStyles.sendButton,
                  { backgroundColor: palette.blue, opacity: sending ? 0.5 : pressed ? 0.72 : 1 },
                ]}
              >
                <Text
                  style={[
                    attachmentStyles.sendText,
                    { color: palette.onBlue, fontFamily: fonts.semibold },
                  ]}
                >
                  {sending
                    ? t("mobileSendingPhoto")
                    : sendFailed
                      ? t("mobileRetryPhoto")
                      : t("mobileSendPhoto")}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

type VisibleAttachment = Exclude<MessageAttachment, null>;

export function MessageAttachmentView({
  attachment,
  fromVisitor,
  onReload,
  palette,
}: {
  attachment: VisibleAttachment;
  fromVisitor: boolean;
  onReload(): void | Promise<void>;
  palette: Palette;
}) {
  const [viewing, setViewing] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const sideStyle = fromVisitor ? attachmentStyles.incoming : attachmentStyles.outgoing;

  if (attachment.removed) {
    return (
      <View
        style={[attachmentStyles.attachmentBubble, sideStyle, { backgroundColor: palette.wash }]}
      >
        <Text style={{ color: palette.sub, fontFamily: fonts.body, fontSize: 14 }}>
          {t(attachment.type === "image" ? "imageRemoved" : "fileRemoved")}
        </Text>
      </View>
    );
  }

  if (attachment.type === "file") {
    return (
      <Pressable
        accessibilityLabel={t("mobileOpenFile", { name: attachment.name })}
        accessibilityRole="link"
        onPress={() => void Linking.openURL(attachment.url).catch(() => onReload())}
        style={({ pressed }) => [
          attachmentStyles.attachmentBubble,
          attachmentStyles.file,
          sideStyle,
          { backgroundColor: palette.wash, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Icon color={palette.blue} name="file" size={22} />
        <View style={attachmentStyles.fileCopy}>
          <Text
            numberOfLines={2}
            style={{ color: palette.ink, fontFamily: fonts.medium, fontSize: 14 }}
          >
            {attachment.name}
          </Text>
          <Text style={{ color: palette.sub, fontFamily: fonts.body, fontSize: 11 }}>
            {sizeLabel(attachment.size)}
          </Text>
        </View>
      </Pressable>
    );
  }

  const didFail = failedUrl === attachment.url;
  if (didFail) {
    return (
      <View
        style={[attachmentStyles.attachmentBubble, sideStyle, { backgroundColor: palette.wash }]}
      >
        <Text style={{ color: palette.sub, fontFamily: fonts.body, fontSize: 13 }}>
          {t("mobileAttachmentLoadFailed")}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setFailedUrl(null);
            void onReload();
          }}
          style={attachmentStyles.reloadButton}
        >
          <Text style={{ color: palette.blue, fontFamily: fonts.semibold, fontSize: 13 }}>
            {t("mobileReloadAttachment")}
          </Text>
        </Pressable>
      </View>
    );
  }

  const sourceRatio =
    attachment.width > 0 && attachment.height > 0 ? attachment.width / attachment.height : 1;
  const ratio = Math.min(1.8, Math.max(0.65, sourceRatio));
  return (
    <>
      <Pressable
        accessibilityLabel={t("imageView")}
        accessibilityRole="imagebutton"
        onPress={() => setViewing(true)}
        style={[attachmentStyles.imageButton, sideStyle, { backgroundColor: palette.wash }]}
      >
        <Image
          accessibilityLabel={t("imageAlt")}
          onError={() => setFailedUrl(attachment.url)}
          resizeMode="cover"
          source={{ uri: attachment.url }}
          style={[attachmentStyles.messageImage, { aspectRatio: ratio }]}
        />
      </Pressable>
      <Modal
        animationType="fade"
        onRequestClose={() => setViewing(false)}
        presentationStyle="overFullScreen"
        transparent
        visible={viewing}
      >
        <View style={attachmentStyles.previewRoot}>
          <Image
            accessibilityLabel={t("imageAlt")}
            onError={() => {
              setViewing(false);
              setFailedUrl(attachment.url);
            }}
            resizeMode="contain"
            source={{ uri: attachment.url }}
            style={attachmentStyles.previewImage}
          />
          <Pressable
            accessibilityLabel={t("mobileDismiss")}
            accessibilityRole="button"
            onPress={() => setViewing(false)}
            style={attachmentStyles.previewClose}
          >
            <Icon color="#ffffff" name="x" size={24} />
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const attachmentStyles = StyleSheet.create({
  composeButton: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 12,
  },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 28, 48, 0.42)",
  },
  sheet: {
    maxHeight: "88%",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  sheetHead: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sheetTitle: { flex: 1, fontSize: 24, lineHeight: 29, letterSpacing: -0.6 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pickedImage: { width: "100%", height: 330, borderRadius: 15 },
  photoMeta: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11 },
  photoName: { flex: 1, fontSize: 13 },
  sendError: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  sendButton: {
    minHeight: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  sendText: { fontSize: 15 },
  attachmentBubble: {
    maxWidth: "88%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 11,
  },
  incoming: {
    alignSelf: "flex-start",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  outgoing: {
    alignSelf: "flex-end",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 4,
  },
  file: { minWidth: 210, flexDirection: "row", alignItems: "center", gap: 10 },
  fileCopy: { flex: 1, gap: 2 },
  reloadButton: { alignSelf: "flex-start", minHeight: 40, justifyContent: "center", marginTop: 2 },
  imageButton: { width: 248, overflow: "hidden", marginBottom: 11 },
  messageImage: { width: "100%" },
  previewRoot: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.94)" },
  previewImage: { flex: 1, width: "100%" },
  previewClose: {
    position: "absolute",
    top: 48,
    right: 14,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
});
