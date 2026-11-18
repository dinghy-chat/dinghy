import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import { beginSignIn, CLOUD_ORIGIN, cancelPendingSignIn, hasPendingSignIn } from "./auth";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { controlShape, type Palette } from "./theme";

export function SignInScreen({
  palette,
  isNight,
  topInset,
  bottomInset,
  completionError,
  onStart,
}: {
  palette: Palette;
  isNight: boolean;
  topInset: number;
  bottomInset: number;
  completionError: string | null;
  onStart(): void;
}) {
  const [selfHosted, setSelfHosted] = useState(false);
  const [server, setServer] = useState("");
  const [serverFocused, setServerFocused] = useState(false);
  const [animated, setAnimated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hasPendingSignIn().then(setPending);
  }, []);
  useEffect(() => {
    if (completionError) void hasPendingSignIn().then(setPending);
  }, [completionError]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void hasPendingSignIn().then(setPending), 30_000);
    return () => clearInterval(timer);
  }, [pending]);

  const begin = async () => {
    if (selfHosted && !server.trim()) return;
    setBusy(true);
    setError(null);
    onStart();
    try {
      await beginSignIn(selfHosted ? server : CLOUD_ORIGIN);
      setPending(true);
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await cancelPendingSignIn();
    setPending(false);
    setError(null);
  };

  const disabled = busy || pending || (selfHosted && !server.trim());
  const water = isNight ? "#17384b" : "#639eaf";
  const controlInk = isNight ? "#eef5f6" : palette.authInk;
  const selectedHost = isNight ? "#315064" : "#ffffff";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[screenStyles.page, { backgroundColor: water }]}
    >
      <ScrollView
        bounces={false}
        contentContainerStyle={screenStyles.content}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={screenStyles.scene}>
          <Harbor animated night={isNight} paused={!animated} />
          <View style={[screenStyles.wordmark, { top: topInset + 9 }]}>
            <View style={screenStyles.boatMark}>
              <Image
                accessible={false}
                source={require("../assets/boat.png")}
                style={screenStyles.boat}
                resizeMode="contain"
              />
            </View>
            <Text style={[screenStyles.brand, { color: controlInk, fontFamily: fonts.display }]}>
              {t("appName")}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={animated ? t("mobilePauseHarbor") : t("mobilePlayHarbor")}
            accessibilityRole="button"
            onPress={() => setAnimated((value) => !value)}
            style={({ pressed }) => [
              screenStyles.motion,
              { top: topInset + 4, opacity: pressed ? 0.68 : 1 },
            ]}
          >
            <View style={[screenStyles.motionDisc, { backgroundColor: palette.authPanel }]}>
              <Icon color={controlInk} name={animated ? "pause" : "play"} size={13} />
            </View>
          </Pressable>
        </View>

        <View
          style={[
            screenStyles.panel,
            {
              backgroundColor: palette.authPanel,
              borderColor: palette.authLine,
              paddingBottom: Math.max(bottomInset, 14) + 10,
            },
          ]}
        >
          {pending ? (
            <>
              <Text
                style={[
                  screenStyles.title,
                  { color: palette.authInk, fontFamily: fonts.displayBold },
                ]}
              >
                {t("nativeMobileSignInBrowserTitle")}
              </Text>
              <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("nativeMobileSignInBrowserCopy")}
              </Text>
              <View
                style={[
                  screenStyles.waiting,
                  { backgroundColor: palette.wash, borderColor: palette.authLine },
                ]}
              >
                <ActivityIndicator color={palette.blue} size="small" />
                <Text
                  style={[
                    screenStyles.waitingText,
                    { color: palette.ink, fontFamily: fonts.medium },
                  ]}
                >
                  {t("mobileWaitingForSignIn")}
                </Text>
              </View>
            </>
          ) : (
            <>
              <Text
                style={[
                  screenStyles.title,
                  { color: palette.authInk, fontFamily: fonts.displayBold },
                ]}
              >
                {t("nativeMobileSignInTitle")}
              </Text>
              <Text
                style={[screenStyles.hostLabel, { color: palette.sub, fontFamily: fonts.semibold }]}
              >
                {t("nativeMobileSignInHostLabel")}
              </Text>
              <View
                accessibilityLabel={t("nativeMobileSignInHostLabel")}
                accessibilityRole="tablist"
                style={[
                  screenStyles.tabs,
                  { backgroundColor: palette.wash, borderColor: palette.authLine },
                ]}
              >
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: !selfHosted }}
                  onPress={() => setSelfHosted(false)}
                  style={[screenStyles.tab, !selfHosted && { backgroundColor: selectedHost }]}
                >
                  <Text
                    style={[
                      screenStyles.tabText,
                      {
                        color: !selfHosted ? palette.authInk : palette.sub,
                        fontFamily: fonts.semibold,
                      },
                    ]}
                  >
                    {t("mobileDinghyCloud")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: selfHosted }}
                  onPress={() => setSelfHosted(true)}
                  style={[screenStyles.tab, selfHosted && { backgroundColor: selectedHost }]}
                >
                  <Text
                    style={[
                      screenStyles.tabText,
                      {
                        color: selfHosted ? palette.authInk : palette.sub,
                        fontFamily: fonts.semibold,
                      },
                    ]}
                  >
                    {t("mobileSelfHosted")}
                  </Text>
                </Pressable>
              </View>
              {selfHosted && (
                <View>
                  <Text
                    style={[
                      screenStyles.fieldLabel,
                      { color: palette.authInk, fontFamily: fonts.semibold },
                    ]}
                  >
                    {t("mobileServerAddress")}
                  </Text>
                  <View
                    style={[
                      screenStyles.field,
                      {
                        backgroundColor: palette.paper,
                        borderColor: serverFocused ? palette.blue : palette.authLine,
                      },
                    ]}
                  >
                    <Icon color={palette.sub} name="server" size={16} />
                    <TextInput
                      accessibilityLabel={t("mobileServerAddress")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      blurOnSubmit
                      editable={!busy}
                      keyboardType="url"
                      onChangeText={setServer}
                      onBlur={() => setServerFocused(false)}
                      onFocus={() => setServerFocused(true)}
                      onSubmitEditing={() => {
                        if (!disabled) void begin();
                      }}
                      placeholder={t("mobileServerPlaceholder")}
                      placeholderTextColor={palette.sub}
                      returnKeyType="go"
                      style={[screenStyles.input, { color: palette.ink, fontFamily: fonts.body }]}
                      value={server}
                    />
                  </View>
                </View>
              )}
            </>
          )}

          {(error ?? completionError) && (
            <Text
              accessibilityRole="alert"
              style={[
                screenStyles.error,
                { color: isNight ? "#ffb3aa" : "#9f2d29", fontFamily: fonts.body },
              ]}
            >
              {error ?? completionError}
            </Text>
          )}

          {!pending && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy, disabled }}
              disabled={disabled}
              onPress={() => void begin()}
              style={({ pressed }) => [
                screenStyles.primary,
                {
                  backgroundColor: isNight ? "#2d75c0" : "#0b5794",
                  opacity: disabled ? 0.45 : pressed ? 0.74 : 1,
                },
              ]}
            >
              <Text style={[screenStyles.primaryText, { fontFamily: fonts.semibold }]}>
                {busy ? t("mobileOpeningSignIn") : t("mobileContinueSignIn")}
              </Text>
            </Pressable>
          )}

          {pending ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void cancel()}
              style={({ pressed }) => [
                screenStyles.cancelButton,
                { borderColor: palette.authLine, opacity: pressed ? 0.64 : 1 },
              ]}
            >
              <Text
                style={[
                  screenStyles.cancelText,
                  { color: palette.blue, fontFamily: fonts.semibold },
                ]}
              >
                {t("mobileCancelSignIn")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const screenStyles = StyleSheet.create({
  page: { flex: 1 },
  content: { flexGrow: 1 },
  scene: { flex: 1, minHeight: 285, position: "relative", overflow: "hidden" },
  wordmark: {
    position: "absolute",
    left: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  boatMark: {
    width: 26,
    height: 26,
    borderRadius: 8,
    padding: 2,
    backgroundColor: "#fff8df",
  },
  boat: { width: 22, height: 22 },
  brand: { fontSize: 25, lineHeight: 30, letterSpacing: -0.9 },
  motion: {
    position: "absolute",
    right: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  motionDisc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.9,
  },
  panel: {
    minHeight: 330,
    marginTop: -30,
    borderTopWidth: 1,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 30,
    shadowColor: "#0b2239",
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 10,
  },
  title: { fontSize: 40, lineHeight: 42, letterSpacing: -1.6, marginBottom: 12 },
  copy: { maxWidth: 330, fontSize: 15, lineHeight: 22, marginBottom: 20 },
  hostLabel: { fontSize: 13, lineHeight: 18, marginBottom: 8 },
  tabs: {
    flexDirection: "row",
    gap: 2,
    padding: 3,
    borderWidth: 1,
    borderRadius: controlShape.pill,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    borderRadius: controlShape.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  tabText: { fontSize: 14 },
  fieldLabel: { fontSize: 13, marginBottom: 7 },
  field: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: controlShape.pill,
    paddingHorizontal: 16,
  },
  input: { flex: 1, minWidth: 0, minHeight: 50, fontSize: 15, paddingVertical: 0 },
  waiting: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: controlShape.pill,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  waitingText: { fontSize: 14 },
  error: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  primary: {
    width: "100%",
    minHeight: 52,
    marginTop: 16,
    borderRadius: controlShape.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 17,
  },
  primaryText: { color: "#ffffff", fontSize: 16 },
  cancelButton: {
    width: "100%",
    minHeight: 48,
    borderWidth: 1,
    borderRadius: controlShape.pill,
    marginTop: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { fontSize: 14 },
});
