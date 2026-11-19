import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LABEL_NAME_MAX, LABELS_MAX } from "../../../packages/widget/src/shared.ts";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
import type { Label, LabelColor, Session } from "./types";

const labelColors: LabelColor[] = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
];

const colorInk: Record<LabelColor, string> = {
  gray: "#77858c",
  red: "#d94841",
  orange: "#d66a1f",
  yellow: "#b9830d",
  green: "#27825f",
  teal: "#16817c",
  blue: "#3574c8",
  purple: "#7d58b3",
};

const colorName: Record<LabelColor, string> = {
  gray: t("colorGray"),
  red: t("colorRed"),
  orange: t("colorOrange"),
  yellow: t("colorYellow"),
  green: t("colorGreen"),
  teal: t("colorTeal"),
  blue: t("colorBlue"),
  purple: t("colorPurple"),
};

type LabelDraft = { id: string | null; name: string; color: LabelColor };
type InstallSnippet = Awaited<ReturnType<DinghyApi["installSnippet"]>>;

function sorted(labels: Label[]): Label[] {
  return [...labels].sort((left, right) => left.name.localeCompare(right.name));
}

function ToolRow({
  detail,
  icon,
  palette,
  title,
  onPress,
}: {
  detail: string;
  icon: "server" | "tag";
  palette: Palette;
  title: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolRow,
        { borderColor: palette.line, opacity: pressed ? 0.68 : 1 },
      ]}
    >
      <View style={styles.toolIcon}>
        <Icon color={palette.ink} name={icon} size={21} />
      </View>
      <View style={styles.toolCopy}>
        <Text style={[styles.toolTitle, { color: palette.ink }]}>{title}</Text>
        <Text numberOfLines={2} style={[styles.toolDetail, { color: palette.sub }]}>
          {detail}
        </Text>
      </View>
      <Icon color={palette.sub} name="next" size={18} />
    </Pressable>
  );
}

function LabelSheet({
  api,
  canWrite,
  palette,
  visible,
  onClose,
}: {
  api: DinghyApi;
  canWrite: boolean;
  palette: Palette;
  visible: boolean;
  onClose(): void;
}) {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [draft, setDraft] = useState<LabelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLabels(null);
    setDraft(null);
    setError(null);
    void api.labels().then(
      (result) => {
        if (active) setLabels(sorted(result.labels));
      },
      (failure) => {
        if (active) setError(readableError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, visible]);

  const save = async () => {
    if (draft === null || !draft.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = { name: draft.name.trim(), color: draft.color };
      const saved =
        draft.id === null ? await api.addLabel(input) : await api.changeLabel(draft.id, input);
      setLabels((current) =>
        sorted([...(current ?? []).filter((item) => item.id !== saved.id), saved]),
      );
      setDraft(null);
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = (label: Label) => {
    Alert.alert(t("labelDeleteTitle", { name: label.name }), t("labelDeleteText"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          setError(null);
          void api.deleteLabel(label.id).then(
            () => {
              setLabels((current) => current?.filter((item) => item.id !== label.id) ?? []);
              if (draft?.id === label.id) setDraft(null);
              setBusy(false);
            },
            (failure) => {
              setError(readableError(failure));
              setBusy(false);
            },
          );
        },
      },
    ]);
  };

  const isFull = labels !== null && labels.length >= LABELS_MAX;
  return (
    <Sheet onClose={onClose} palette={palette} title={t("pageLabels")} visible={visible}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetScroll}>
        {labels === null && error === null && (
          <ActivityIndicator color={palette.blue} style={styles.loading} />
        )}
        {labels?.length === 0 && (
          <Text style={[styles.empty, { color: palette.sub }]}>{t("labelsPageNone")}</Text>
        )}
        {labels?.map((label) => (
          <View key={label.id} style={[styles.labelRow, { borderBottomColor: palette.line }]}>
            <View style={[styles.colorDot, { backgroundColor: colorInk[label.color] }]} />
            <Text style={[styles.labelName, { color: palette.ink }]}>{label.name}</Text>
            {canWrite && (
              <>
                <Pressable
                  accessibilityLabel={t("labelEditLabel", { name: label.name })}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => setDraft({ id: label.id, name: label.name, color: label.color })}
                  style={styles.rowAction}
                >
                  <Text style={[styles.rowActionText, { color: palette.blue }]}>{t("edit")}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={t("labelDeleteLabel", { name: label.name })}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => remove(label)}
                  style={styles.rowAction}
                >
                  <Text style={[styles.rowActionText, { color: palette.sub }]}>{t("delete")}</Text>
                </Pressable>
              </>
            )}
          </View>
        ))}

        {error !== null && <Text style={[styles.error, { color: palette.amber }]}>{error}</Text>}

        {canWrite && draft === null && !isFull && labels !== null && (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => setDraft({ id: null, name: "", color: "gray" })}
            style={({ pressed }) => [styles.addButton, { opacity: pressed ? 0.68 : 1 }]}
          >
            <Icon color={palette.blue} name="plus" size={18} />
            <Text style={[styles.addButtonText, { color: palette.blue }]}>{t("labelNew")}</Text>
          </Pressable>
        )}
        {canWrite && isFull && (
          <Text style={[styles.limit, { color: palette.sub }]}>{t("labelLimit")}</Text>
        )}

        {draft !== null && (
          <View style={[styles.form, { borderTopColor: palette.line }]}>
            <Text style={[styles.formLabel, { color: palette.ink }]}>{t("labelName")}</Text>
            <TextInput
              accessibilityLabel={t("labelName")}
              autoCapitalize="sentences"
              autoCorrect={false}
              autoFocus
              editable={!busy}
              maxLength={LABEL_NAME_MAX}
              onChangeText={(name) =>
                setDraft((current) => (current ? { ...current, name } : null))
              }
              onSubmitEditing={() => void save()}
              returnKeyType="done"
              style={[
                styles.input,
                { backgroundColor: palette.wash, borderColor: palette.line, color: palette.ink },
              ]}
              value={draft.name}
            />
            <Text style={[styles.formLabel, { color: palette.ink }]}>{t("labelColor")}</Text>
            <View accessibilityRole="radiogroup" style={styles.colors}>
              {labelColors.map((color) => (
                <Pressable
                  accessibilityLabel={colorName[color]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: draft.color === color }}
                  disabled={busy}
                  key={color}
                  onPress={() => setDraft((current) => (current ? { ...current, color } : null))}
                  style={[
                    styles.colorChoice,
                    {
                      backgroundColor: palette.wash,
                      borderColor: draft.color === color ? palette.blue : palette.line,
                    },
                  ]}
                >
                  <View style={[styles.colorDot, { backgroundColor: colorInk[color] }]} />
                  <Text style={[styles.colorText, { color: palette.ink }]}>{colorName[color]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.formActions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => setDraft(null)}
                style={styles.secondaryButton}
              >
                <Text style={[styles.buttonText, { color: palette.sub }]}>{t("cancel")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy || !draft.name.trim()}
                onPress={() => void save()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: palette.ink,
                    opacity: busy || !draft.name.trim() ? 0.42 : pressed ? 0.72 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, { color: palette.paper }]}>
                  {busy ? t("loading") : draft.id === null ? t("labelAdd") : t("save")}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}

function InstallSheet({
  api,
  palette,
  visible,
  onClose,
}: {
  api: DinghyApi;
  palette: Palette;
  visible: boolean;
  onClose(): void;
}) {
  const [snippet, setSnippet] = useState<InstallSnippet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setSnippet(null);
    setError(null);
    void api.installSnippet().then(
      (result) => {
        if (active) setSnippet(result);
      },
      (failure) => {
        if (active) setError(readableError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, visible]);

  const copy = (value: string) => {
    void Clipboard.setStringAsync(value).then(() =>
      AccessibilityInfo.announceForAccessibility(t("copied")),
    );
  };

  return (
    <Sheet onClose={onClose} palette={palette} title={t("pageInstall")} visible={visible}>
      <ScrollView style={styles.sheetScroll}>
        {snippet === null && error === null && (
          <ActivityIndicator color={palette.blue} style={styles.loading} />
        )}
        {error !== null && <Text style={[styles.error, { color: palette.amber }]}>{error}</Text>}
        {snippet !== null && (
          <>
            <Text style={[styles.installTitle, { color: palette.ink }]}>{t("snippetTitle")}</Text>
            <Text style={[styles.installHelp, { color: palette.sub }]}>{t("snippetHelp")}</Text>
            <View style={[styles.codeBlock, { backgroundColor: palette.wash }]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={[styles.code, { color: palette.ink }]}>
                  {snippet.code}
                </Text>
              </ScrollView>
              <Pressable
                accessibilityLabel={t("copyValue", { name: t("mobileInstallCode") })}
                accessibilityRole="button"
                onPress={() => copy(snippet.code)}
                style={[styles.copyButton, { backgroundColor: palette.ink }]}
              >
                <Text style={[styles.copyButtonText, { color: palette.paper }]}>{t("copy")}</Text>
              </Pressable>
            </View>

            <Text style={[styles.installLabel, { color: palette.ink }]}>
              {t("mobilePublicInstallKey")}
            </Text>
            <View style={[styles.keyRow, { backgroundColor: palette.wash }]}>
              <Text numberOfLines={1} selectable style={[styles.key, { color: palette.ink }]}>
                {snippet.publicKey}
              </Text>
              <Pressable
                accessibilityLabel={t("copyValue", { name: t("mobilePublicInstallKey") })}
                accessibilityRole="button"
                onPress={() => copy(snippet.publicKey)}
                style={styles.keyCopy}
              >
                <Text style={[styles.rowActionText, { color: palette.blue }]}>{t("copy")}</Text>
              </Pressable>
            </View>

            <Text style={[styles.installLabel, { color: palette.ink }]}>{snippet.file}</Text>
            <Text style={[styles.installHelp, { color: palette.sub }]}>{snippet.placement}</Text>
            {snippet.notes.map((note) => (
              <Text key={note} style={[styles.note, { color: palette.sub }]}>
                {`• ${note}`}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

export function AdminTools({
  api,
  session,
  palette,
  canWrite,
}: {
  api: DinghyApi;
  session: Session;
  palette: Palette;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState<"install" | "labels" | null>(null);
  return (
    <>
      <ToolRow
        detail={t("labelsContext")}
        icon="tag"
        onPress={() => setOpen("labels")}
        palette={palette}
        title={t("pageLabels")}
      />
      <ToolRow
        detail={`${session.workspace.name} · ${t("snippetHelp")}`}
        icon="server"
        onPress={() => setOpen("install")}
        palette={palette}
        title={t("pageInstall")}
      />
      <LabelSheet
        api={api}
        canWrite={canWrite}
        onClose={() => setOpen(null)}
        palette={palette}
        visible={open === "labels"}
      />
      <InstallSheet
        api={api}
        onClose={() => setOpen(null)}
        palette={palette}
        visible={open === "install"}
      />
    </>
  );
}

const styles = StyleSheet.create({
  toolRow: {
    minHeight: 76,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  toolIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  toolCopy: { flex: 1, minWidth: 0 },
  toolTitle: { fontFamily: fonts.semibold, fontSize: 17 },
  toolDetail: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, marginTop: 3 },
  sheetScroll: { maxHeight: 650, paddingHorizontal: 18 },
  loading: { marginVertical: 34 },
  empty: { fontFamily: fonts.body, fontSize: 14, textAlign: "center", paddingVertical: 24 },
  labelRow: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  labelName: { flex: 1, minWidth: 0, fontFamily: fonts.semibold, fontSize: 16 },
  rowAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 6 },
  rowActionText: { fontFamily: fonts.semibold, fontSize: 14 },
  error: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, marginVertical: 12 },
  addButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginVertical: 8,
  },
  addButtonText: { fontFamily: fonts.semibold, fontSize: 15 },
  limit: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, marginVertical: 14 },
  form: { paddingTop: 18, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, gap: 9 },
  formLabel: { fontFamily: fonts.semibold, fontSize: 14 },
  input: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  colors: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  colorChoice: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  colorText: { fontFamily: fonts.medium, fontSize: 13 },
  formActions: { flexDirection: "row", justifyContent: "flex-end", gap: 9, marginTop: 5 },
  secondaryButton: {
    minHeight: 46,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButton: {
    minHeight: 46,
    minWidth: 92,
    borderRadius: 23,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontFamily: fonts.semibold, fontSize: 15 },
  installTitle: { fontFamily: fonts.display, fontSize: 22, marginTop: 8 },
  installHelp: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, marginTop: 4 },
  codeBlock: { borderRadius: 15, padding: 12, gap: 12, marginTop: 14 },
  code: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 19,
    paddingVertical: 3,
  },
  copyButton: {
    minHeight: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    alignSelf: "flex-end",
  },
  copyButtonText: { fontFamily: fonts.semibold, fontSize: 14 },
  installLabel: { fontFamily: fonts.semibold, fontSize: 15, marginTop: 20 },
  keyRow: {
    minHeight: 48,
    borderRadius: 14,
    marginTop: 8,
    paddingLeft: 13,
    flexDirection: "row",
    alignItems: "center",
  },
  key: { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 13 },
  keyCopy: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14 },
  note: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, marginTop: 7 },
});
