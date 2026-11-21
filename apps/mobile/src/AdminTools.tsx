import * as Clipboard from "expo-clipboard";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { LABEL_NAME_MAX, LABELS_MAX } from "../../../packages/widget/src/shared.ts";
import { t } from "../../operator/src/text.ts";
import { ApiError, type DinghyApi } from "./api";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { inboxStyles as screen } from "./inbox-styles";
import { Sheet } from "./sheet";
import { night, type Palette } from "./theme";
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

type Tone = { soft: string; ink: string };

// The web's label pills (`[data-color]` in apps/operator/public/app.css), so a label looks the same
// on both.
const labelTones: Record<"day" | "night", Record<LabelColor, Tone>> = {
  day: {
    gray: { soft: "#eceae4", ink: "#4a5565" },
    red: { soft: "#fde3e1", ink: "#a8261d" },
    orange: { soft: "#fde8d6", ink: "#9a4a0b" },
    yellow: { soft: "#faf0c8", ink: "#7a5b00" },
    green: { soft: "#dcf1e4", ink: "#17703f" },
    teal: { soft: "#d8f0ef", ink: "#0f6a68" },
    blue: { soft: "#e0eaff", ink: "#1d55c4" },
    purple: { soft: "#ece4fb", ink: "#6237b3" },
  },
  night: {
    gray: { soft: "#26323f", ink: "#c3ccd6" },
    red: { soft: "#4a2226", ink: "#ff9d95" },
    orange: { soft: "#4a2f1b", ink: "#ffb77a" },
    yellow: { soft: "#43391a", ink: "#ffd96b" },
    green: { soft: "#1c3a2b", ink: "#7fdca5" },
    teal: { soft: "#183a3a", ink: "#7fd8d4" },
    blue: { soft: "#1b2f50", ink: "#9cc3ff" },
    purple: { soft: "#33264d", ink: "#c9adff" },
  },
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

// The web's `--code-*` tokens. The block stays navy in both themes, as on the web and in the docs.
const code = {
  day: { block: "#0b2239", bar: "#17335c" },
  night: { block: "#070e15", bar: "#15212e" },
  ink: "#eef4fb",
  mute: "#a4b8d0",
  tag: "#ff9d84",
  attr: "#8fc5ff",
  string: "#ffd76a",
} as const;
const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

const GUIDE_URL = "https://dinghy.chat/docs/add-to-your-site#add-the-tag";
const COPIED_MS = 1800;

type LabelDraft = { id: string | null; name: string; color: LabelColor };
type InstallSnippet = Awaited<ReturnType<DinghyApi["installSnippet"]>>;

function sorted(labels: Label[]): Label[] {
  return [...labels].sort((left, right) => left.name.localeCompare(right.name));
}

function failureText(failure: unknown): string {
  if (failure instanceof ApiError && failure.code === "label_name_taken") {
    return t("labelNameTaken");
  }
  return readableError(failure);
}

/** Large text narrows the sheet in points, so rows stack once the text would crowd. */
function useNarrow(limit: number): boolean {
  const { width, fontScale } = useWindowDimensions();
  return width / fontScale < limit;
}

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (key: string, value: string) => {
    void Clipboard.setStringAsync(value).then(
      () => {
        setCopied(key);
        AccessibilityInfo.announceForAccessibility(t("copied"));
      },
      () => undefined,
    );
  };
  return { copied, copy };
}

function SectionTitle({ palette, children }: { palette: Palette; children: string }) {
  return (
    <Text accessibilityRole="header" style={[s.sectionTitle, { color: palette.sub }]}>
      {children}
    </Text>
  );
}

function LoadState({
  error,
  palette,
  onRetry,
}: {
  error: string | null;
  palette: Palette;
  onRetry(): void;
}) {
  if (error === null) {
    return (
      <ActivityIndicator accessibilityLabel={t("loading")} color={palette.blue} style={s.loading} />
    );
  }
  return (
    <View style={s.loadError}>
      <Text accessibilityRole="alert" style={[s.note, s.center, { color: palette.danger }]}>
        {error}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          s.outlineButton,
          { borderColor: palette.line },
          pressed && s.pressed,
        ]}
      >
        <Text style={[s.buttonText, { color: palette.ink }]}>{t("mobileRetry")}</Text>
      </Pressable>
    </View>
  );
}

function LabelPill({
  color,
  name,
  palette,
  large = false,
}: {
  color: LabelColor;
  name: string;
  palette: Palette;
  large?: boolean;
}) {
  const tone = labelTones[palette === night ? "night" : "day"][color];
  return (
    <View style={[s.pill, large && s.pillLarge, { backgroundColor: tone.soft }]}>
      <View style={[s.pillDot, { backgroundColor: tone.ink }]} />
      <Text style={[s.pillText, large && s.pillTextLarge, { color: tone.ink }]}>{name}</Text>
    </View>
  );
}

function LabelForm({
  busy,
  draft,
  error,
  palette,
  onCancel,
  onChange,
  onDelete,
  onSave,
}: {
  busy: boolean;
  draft: LabelDraft;
  error: string | null;
  palette: Palette;
  onCancel(): void;
  onChange(draft: LabelDraft): void;
  onDelete(): void;
  onSave(): void;
}) {
  const stacked = useNarrow(300);
  const oneColumn = useNarrow(330);
  const canSave = !busy && draft.name.trim() !== "";
  const title = (
    <Text
      accessibilityRole="header"
      style={[s.barTitle, stacked && s.stackedTitle, { color: palette.ink }]}
    >
      {draft.id === null ? t("labelNew") : t("mobileLabelEditTitle")}
    </Text>
  );
  return (
    <>
      <View style={[s.bar, stacked && s.spread]}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          hitSlop={6}
          onPress={onCancel}
          style={({ pressed }) => [s.barButton, pressed && s.pressed]}
        >
          <Text style={[s.barText, { color: palette.blue }]}>{t("cancel")}</Text>
        </Pressable>
        {!stacked && title}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave, busy }}
          disabled={!canSave}
          hitSlop={6}
          onPress={onSave}
          style={({ pressed }) => [s.barButton, s.barEnd, pressed && s.pressed]}
        >
          {busy ? (
            <ActivityIndicator color={palette.blue} />
          ) : (
            <Text style={[s.barText, s.barSave, { color: canSave ? palette.blue : palette.sub }]}>
              {t("save")}
            </Text>
          )}
        </Pressable>
      </View>
      <ScrollView
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        style={s.scroll}
        contentContainerStyle={s.body}
      >
        {stacked && title}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={s.preview}
        >
          <LabelPill
            color={draft.color}
            large
            name={draft.name.trim() || t("mobileLabelPreview")}
            palette={palette}
          />
        </View>
        <View style={[s.card, { backgroundColor: palette.wash }]}>
          <View style={[s.fieldRow, stacked && s.fieldStacked]}>
            <Text style={[s.fieldLabel, stacked && s.autoWidth, { color: palette.ink }]}>
              {t("labelName")}
            </Text>
            <TextInput
              accessibilityLabel={t("labelName")}
              autoCapitalize="sentences"
              autoCorrect={false}
              autoFocus={draft.id === null}
              clearButtonMode="while-editing"
              editable={!busy}
              enterKeyHint="done"
              maxLength={LABEL_NAME_MAX}
              onChangeText={(name) => onChange({ ...draft, name })}
              onSubmitEditing={() => {
                if (canSave) onSave();
              }}
              placeholder={t("mobileLabelPreview")}
              placeholderTextColor={palette.sub}
              returnKeyType="done"
              selectionColor={palette.blue}
              style={[s.fieldInput, stacked && s.fieldInputStacked, { color: palette.ink }]}
              value={draft.name}
            />
          </View>
        </View>

        <SectionTitle palette={palette}>{t("labelColor")}</SectionTitle>
        <View accessibilityRole="radiogroup" style={s.swatches}>
          {labelColors.map((color) => {
            const selected = draft.color === color;
            const tone = labelTones[palette === night ? "night" : "day"][color];
            return (
              <Pressable
                accessibilityLabel={colorName[color]}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                key={color}
                onPress={() => onChange({ ...draft, color })}
                style={({ pressed }) => [
                  s.swatch,
                  oneColumn ? s.swatchFull : s.swatchHalf,
                  {
                    backgroundColor: palette.wash,
                    borderColor: selected ? palette.blue : "transparent",
                  },
                  pressed && s.pressed,
                ]}
              >
                <View style={[s.swatchDot, { backgroundColor: tone.ink }]} />
                <Text style={[s.swatchText, { color: palette.ink }]}>{colorName[color]}</Text>
                {selected && <Icon color={palette.blue} name="check" size={18} />}
              </Pressable>
            );
          })}
        </View>

        {error !== null && (
          <Text accessibilityRole="alert" style={[s.note, { color: palette.danger }]}>
            {error}
          </Text>
        )}

        {draft.id !== null && (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onDelete}
            style={({ pressed }) => [
              s.deleteButton,
              { backgroundColor: palette.wash },
              pressed && s.pressed,
            ]}
          >
            <Text style={[s.buttonText, { color: palette.danger }]}>{t("mobileLabelDelete")}</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

function LabelSheet({
  api,
  canWrite,
  labels,
  loadError,
  palette,
  visible,
  onChange,
  onClose,
  onReload,
}: {
  api: DinghyApi;
  canWrite: boolean;
  labels: Label[] | null;
  loadError: string | null;
  palette: Palette;
  visible: boolean;
  onChange(labels: Label[]): void;
  onClose(): void;
  onReload(): void;
}) {
  const [draft, setDraft] = useState<LabelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(null);
    setError(null);
  }, [visible]);

  const open = (next: LabelDraft) => {
    setError(null);
    setDraft(next);
  };

  const save = async () => {
    if (draft === null || !draft.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = { name: draft.name.trim(), color: draft.color };
      const saved =
        draft.id === null ? await api.addLabel(input) : await api.changeLabel(draft.id, input);
      onChange(sorted([...(labels ?? []).filter((item) => item.id !== saved.id), saved]));
      setDraft(null);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = (label: Pick<Label, "id" | "name">) => {
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
              onChange((labels ?? []).filter((item) => item.id !== label.id));
              setDraft((current) => (current?.id === label.id ? null : current));
              setBusy(false);
            },
            (failure) => {
              setError(failureText(failure));
              setBusy(false);
            },
          );
        },
      },
    ]);
  };

  const isFull = labels !== null && labels.length >= LABELS_MAX;
  const canAdd = canWrite && !isFull && !busy;
  const newLabel = () => open({ id: null, name: "", color: "gray" });

  let content: ReactNode;
  if (labels === null) {
    content = <LoadState error={loadError} onRetry={onReload} palette={palette} />;
  } else if (labels.length === 0) {
    content = (
      <View style={s.empty}>
        <Image accessible={false} source={require("../assets/boat.png")} style={s.emptyMark} />
        <Text accessibilityRole="header" style={[s.emptyTitle, { color: palette.ink }]}>
          {t("mobileLabelsNoneTitle")}
        </Text>
        <Text style={[s.emptyHelp, { color: palette.sub }]}>{t("mobileLabelsNoneHelp")}</Text>
        {canAdd && (
          <Pressable
            accessibilityRole="button"
            onPress={newLabel}
            style={({ pressed }) => [
              s.primaryButton,
              { backgroundColor: palette.blue },
              pressed && s.pressed,
            ]}
          >
            <Icon color={palette.onBlue} name="plus" size={18} />
            <Text style={[s.buttonText, { color: palette.onBlue }]}>{t("labelNew")}</Text>
          </Pressable>
        )}
      </View>
    );
  } else {
    content = (
      <View style={[s.card, { backgroundColor: palette.wash }]}>
        {labels.map((label, index) => (
          <Pressable
            accessibilityActions={
              canWrite
                ? [
                    { name: "activate", label: t("labelEditLabel", { name: label.name }) },
                    { name: "delete", label: t("labelDeleteLabel", { name: label.name }) },
                  ]
                : undefined
            }
            accessibilityLabel={t("mobileLabelItem", {
              name: label.name,
              color: colorName[label.color],
            })}
            accessibilityRole={canWrite ? "button" : "text"}
            accessibilityState={{ disabled: !canWrite || busy }}
            disabled={!canWrite || busy}
            key={label.id}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "delete") remove(label);
              else open({ ...label });
            }}
            onPress={() => open({ ...label })}
            style={({ pressed }) => pressed && s.pressedRow}
          >
            {index > 0 && <View style={[s.divider, { backgroundColor: palette.line }]} />}
            <View style={s.labelRow}>
              <View style={s.labelPillWrap}>
                <LabelPill color={label.color} name={label.name} palette={palette} />
              </View>
              {canWrite && <Icon color={palette.sub} name="next" size={18} />}
            </View>
          </Pressable>
        ))}
        {canAdd && (
          <Pressable
            accessibilityRole="button"
            onPress={newLabel}
            style={({ pressed }) => pressed && s.pressedRow}
          >
            <View style={[s.divider, { backgroundColor: palette.line }]} />
            <View style={s.labelRow}>
              <Icon color={palette.blue} name="plus" size={20} />
              <Text style={[s.addText, { color: palette.blue }]}>{t("labelNew")}</Text>
            </View>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Sheet
      onClose={onClose}
      palette={palette}
      {...(draft === null ? { title: t("pageLabels") } : {})}
      visible={visible}
    >
      {draft !== null ? (
        <LabelForm
          busy={busy}
          draft={draft}
          error={error}
          onCancel={() => setDraft(null)}
          onChange={setDraft}
          onDelete={() => {
            if (draft.id !== null) remove({ id: draft.id, name: draft.name.trim() || draft.name });
          }}
          onSave={() => void save()}
          palette={palette}
        />
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.body}>
          {content}
          {error !== null && (
            <Text accessibilityRole="alert" style={[s.note, { color: palette.danger }]}>
              {error}
            </Text>
          )}
          {canWrite && isFull && (
            <Text style={[s.note, { color: palette.sub }]}>{t("labelLimit")}</Text>
          )}
          {!canWrite && labels !== null && (
            <Text style={[s.note, { color: palette.sub }]}>{t("mobileLabelsLocked")}</Text>
          )}
        </ScrollView>
      )}
    </Sheet>
  );
}

/** The snippet in the docs' colors. Joined, the spans give back the snippet exactly. */
function codeSpans(value: string): ReactNode {
  // The install endpoint returns an HTML tag. Keep every separator and whitespace character.
  const tokens = /<\/?[\w-]+|\/?>|"[^"]*"|'[^']*'|[\w:-]+(?=\s*=|\s*\/?>)/g;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(tokens)) {
    const token = match[0];
    const color = /^['"]/.test(token) ? code.string : /[<>]/.test(token) ? code.tag : code.attr;
    nodes.push(value.slice(offset, match.index));
    nodes.push(
      <Text key={match.index} style={{ color }}>
        {token}
      </Text>,
    );
    offset = match.index + token.length;
  }
  nodes.push(value.slice(offset));
  return nodes;
}

function CopyButton({
  copied,
  label,
  palette,
  onPress,
}: {
  copied: boolean;
  label: string;
  palette: Palette;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [s.textButton, pressed && s.pressed]}
    >
      <Icon color={palette.blue} name={copied ? "check" : "copy"} size={18} />
      <Text style={[s.buttonText, { color: palette.blue }]}>
        {copied ? t("copied") : t("copy")}
      </Text>
    </Pressable>
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
  const request = useRef(0);
  const { copied, copy } = useCopied();
  const stacked = useNarrow(330);
  const shade = palette === night ? code.night : code.day;

  const load = useCallback(() => {
    const id = ++request.current;
    setError(null);
    void api.installSnippet().then(
      (result) => {
        if (id === request.current) setSnippet(result);
      },
      (failure) => {
        if (id === request.current) setError(readableError(failure));
      },
    );
  }, [api]);

  useEffect(() => {
    if (!visible) return;
    load();
    return () => {
      request.current += 1;
    };
  }, [load, visible]);

  const share = (value: string) => {
    void Share.share(
      { message: value },
      { dialogTitle: t("mobileInstallTitle"), subject: t("mobileInstallTitle") },
    ).catch(() => undefined);
  };

  // The HTML snippet's first note repeats the help line above the code, so the list starts after it.
  const steps = snippet?.notes.slice(1) ?? [];
  return (
    <Sheet onClose={onClose} palette={palette} title={t("mobileInstallTitle")} visible={visible}>
      <ScrollView style={s.scroll} contentContainerStyle={s.body}>
        {snippet === null ? (
          <LoadState error={error} onRetry={load} palette={palette} />
        ) : (
          <>
            <Text style={[s.lede, { color: palette.sub }]}>{t("snippetHelp")}</Text>

            <View
              style={[s.codeBlock, { backgroundColor: shade.block, borderColor: palette.line }]}
            >
              <View style={[s.codeBar, { backgroundColor: shade.bar }]}>
                <Text style={[s.codeBarText, { color: code.mute }]}>{t("codeHtml")}</Text>
              </View>
              <Text selectable style={[s.code, { color: code.ink }]}>
                {codeSpans(snippet.code)}
              </Text>
            </View>

            <View style={[s.actions, stacked && s.actionsStacked]}>
              <Pressable
                accessibilityLabel={t("copyValue", { name: t("mobileInstallCode") })}
                accessibilityRole="button"
                onPress={() => copy("code", snippet.code)}
                style={({ pressed }) => [
                  s.primaryButton,
                  !stacked && s.actionButton,
                  { backgroundColor: palette.blue },
                  pressed && s.pressed,
                ]}
              >
                <Icon
                  color={palette.onBlue}
                  name={copied === "code" ? "check" : "copy"}
                  size={18}
                />
                <Text style={[s.buttonText, { color: palette.onBlue }]}>
                  {copied === "code" ? t("copied") : t("mobileInstallCopyCode")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => share(snippet.code)}
                style={({ pressed }) => [
                  s.outlineButton,
                  !stacked && s.actionButton,
                  { borderColor: palette.line },
                  pressed && s.pressed,
                ]}
              >
                <Icon color={palette.ink} name="share" size={18} />
                <Text style={[s.buttonText, { color: palette.ink }]}>
                  {t("mobileInstallShare")}
                </Text>
              </Pressable>
            </View>

            {steps.length > 0 && (
              <>
                <SectionTitle palette={palette}>{t("mobileInstallThen")}</SectionTitle>
                <View style={[s.card, { backgroundColor: palette.wash }]}>
                  {steps.map((step, index) => (
                    <View key={step}>
                      {index > 0 && <View style={[s.divider, { backgroundColor: palette.line }]} />}
                      <View style={s.step}>
                        <View style={[s.stepNumber, { backgroundColor: palette.tint }]}>
                          <Text style={[s.stepNumberText, { color: palette.blue }]}>
                            {index + 1}
                          </Text>
                        </View>
                        <Text style={[s.stepText, { color: palette.ink }]}>{step}</Text>
                      </View>
                    </View>
                  ))}
                </View>
                <Text style={[s.note, { color: palette.sub }]}>{t("mobileInstallSitesOnWeb")}</Text>
              </>
            )}

            <SectionTitle palette={palette}>{t("mobilePublicInstallKey")}</SectionTitle>
            <View
              style={[s.card, s.keyRow, stacked && s.keyStacked, { backgroundColor: palette.wash }]}
            >
              <Text selectable style={[s.key, stacked && s.keyStackedText, { color: palette.ink }]}>
                {snippet.publicKey}
              </Text>
              <CopyButton
                copied={copied === "key"}
                label={t("copyValue", { name: t("mobilePublicInstallKey") })}
                onPress={() => copy("key", snippet.publicKey)}
                palette={palette}
              />
            </View>

            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(GUIDE_URL).catch(() => undefined)}
              style={({ pressed }) => [
                s.card,
                s.guide,
                { backgroundColor: palette.wash },
                pressed && s.pressed,
              ]}
            >
              <Icon color={palette.blue} name="book" size={21} />
              <Text style={[s.guideText, { color: palette.blue }]}>{t("installDocsLink")}</Text>
              <Icon color={palette.sub} name="next" size={18} />
            </Pressable>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function ToolRow({
  detail,
  icon,
  palette,
  title,
  onPress,
}: {
  detail?: string | undefined;
  icon: "code" | "tag";
  palette: Palette;
  title: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        screen.preferenceRow,
        { borderColor: palette.line, opacity: pressed ? 0.68 : 1 },
      ]}
    >
      <View style={screen.preferenceIcon}>
        <Icon color={palette.ink} name={icon} size={21} />
      </View>
      <View style={screen.preferenceCopy}>
        <Text style={[screen.preferenceTitle, { color: palette.ink }]}>{title}</Text>
        {detail !== undefined && (
          <Text style={[screen.preferenceDetail, { color: palette.sub }]}>{detail}</Text>
        )}
      </View>
      <Icon color={palette.sub} name="next" size={18} />
    </Pressable>
  );
}

export function AdminTools({
  api,
  palette,
  canWrite,
}: {
  api: DinghyApi;
  session: Session;
  palette: Palette;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState<"install" | "labels" | null>(null);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);

  // The row shows the count, and the sheet reloads it so a change made on the web shows here.
  const load = useCallback(() => {
    const id = ++request.current;
    setLoadError(null);
    void api.labels().then(
      (result) => {
        if (id === request.current) setLabels(sorted(result.labels));
      },
      (failure) => {
        if (id === request.current) setLoadError(readableError(failure));
      },
    );
  }, [api]);

  useEffect(() => {
    load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  return (
    <>
      <ToolRow
        detail={
          labels === null
            ? undefined
            : labels.length === 0
              ? t("mobileLabelsNoneTitle")
              : t("mobileSettingsLabelCount", { count: labels.length })
        }
        icon="tag"
        onPress={() => {
          load();
          setOpen("labels");
        }}
        palette={palette}
        title={t("pageLabels")}
      />
      <ToolRow
        icon="code"
        onPress={() => setOpen("install")}
        palette={palette}
        title={t("mobileInstallTitle")}
      />
      <LabelSheet
        api={api}
        canWrite={canWrite}
        labels={labels}
        loadError={loadError}
        onChange={(next) => {
          request.current += 1;
          setLabels(next);
        }}
        onClose={() => setOpen(null)}
        onReload={load}
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

const s = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 16, gap: 12 },
  loading: { marginVertical: 40 },
  loadError: { alignItems: "center", gap: 12, paddingVertical: 28 },
  center: { textAlign: "center" },
  pressed: { opacity: 0.6 },
  pressedRow: { opacity: 0.6 },
  sectionTitle: {
    marginTop: 10,
    paddingHorizontal: 4,
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  note: { paddingHorizontal: 4, fontFamily: fonts.body, fontSize: 13.5, lineHeight: 18 },
  lede: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  card: { borderRadius: 14, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  buttonText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20 },
  primaryButton: {
    minHeight: 48,
    borderRadius: 24,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  outlineButton: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  textButton: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },

  // Labels
  empty: { alignItems: "center", paddingTop: 22, paddingBottom: 12, paddingHorizontal: 12 },
  emptyMark: { width: 56, height: 56, opacity: 0.85 },
  emptyTitle: {
    marginTop: 10,
    fontFamily: fonts.semibold,
    fontSize: 17,
    lineHeight: 22,
    textAlign: "center",
  },
  emptyHelp: {
    marginTop: 4,
    marginBottom: 18,
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: 20,
    textAlign: "center",
  },
  labelRow: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  labelPillWrap: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  addText: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21 },
  pill: {
    maxWidth: "100%",
    minHeight: 28,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  pillLarge: { minHeight: 38, borderRadius: 19, paddingHorizontal: 15, gap: 9 },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14.5, lineHeight: 19 },
  pillTextLarge: { fontSize: 17, lineHeight: 22 },
  preview: { alignItems: "center", paddingVertical: 14 },
  fieldRow: {
    minHeight: 50,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  fieldStacked: { flexDirection: "column", alignItems: "stretch", gap: 3, paddingVertical: 10 },
  fieldLabel: { width: 64, fontFamily: fonts.medium, fontSize: 16, lineHeight: 21 },
  autoWidth: { width: "auto" },
  fieldInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    paddingVertical: 0,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  fieldInputStacked: { flex: 0, minHeight: 44 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  swatch: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 2,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  swatchHalf: { width: "48.5%" },
  swatchFull: { width: "100%" },
  swatchDot: { width: 16, height: 16, borderRadius: 8 },
  swatchText: { flex: 1, fontFamily: fonts.medium, fontSize: 15, lineHeight: 20 },
  deleteButton: {
    marginTop: 10,
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  bar: { minHeight: 48, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  spread: { justifyContent: "space-between" },
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
  stackedTitle: { flex: 0, textAlign: "left", fontSize: 20, lineHeight: 25 },

  // Install
  codeBlock: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  codeBar: { minHeight: 38, paddingHorizontal: 16, justifyContent: "center" },
  codeBarText: { fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 18 },
  code: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    fontFamily: mono,
    fontSize: 13.5,
    lineHeight: 22,
  },
  actions: { flexDirection: "row", gap: 10 },
  actionsStacked: { flexDirection: "column" },
  actionButton: { flexGrow: 1, flexBasis: 0 },
  step: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 17 },
  stepText: { flex: 1, minWidth: 0, fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  keyRow: {
    minHeight: 52,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  keyStacked: { flexDirection: "column", alignItems: "flex-start", paddingTop: 12 },
  key: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: 13.5, lineHeight: 20 },
  keyStackedText: { flex: 0, alignSelf: "stretch" },
  guide: {
    minHeight: 52,
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  guideText: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21 },
});
