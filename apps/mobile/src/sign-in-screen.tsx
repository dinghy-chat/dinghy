import { useEffect, useState } from "react";
import {
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
import type { Palette } from "./theme";

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
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [selfHosted, setSelfHosted] = useState(false);
  const [server, setServer] = useState("");
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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[screenStyles.page, { backgroundColor: water }]}
    >
      <ScrollView
        bounces={false}
        contentContainerStyle={[screenStyles.content, { paddingBottom: Math.max(bottomInset, 3) }]}
        keyboardShouldPersistTaps="handled"
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

        <View style={[screenStyles.card, { backgroundColor: palette.authPanel }]}>
          {pending ? (
            <>
              <Text
                style={[screenStyles.title, { color: palette.authInk, fontFamily: fonts.display }]}
              >
                {t("nativeMobileSignInBrowserTitle")}
              </Text>
              <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("nativeMobileSignInBrowserCopy")}
              </Text>
            </>
          ) : choosingWorkspace ? (
            <>
              <Text
                style={[screenStyles.title, { color: palette.authInk, fontFamily: fonts.display }]}
              >
                {t("signInTitle")}
              </Text>
              <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
                {selfHosted ? t("nativeMobileSignInServerCopy") : t("nativeMobileSignInCloudCopy")}
              </Text>
              <View
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
                  style={[screenStyles.tab, !selfHosted && { backgroundColor: palette.authPanel }]}
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
                  style={[screenStyles.tab, selfHosted && { backgroundColor: palette.authPanel }]}
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
                      { backgroundColor: palette.paper, borderColor: palette.authLine },
                    ]}
                  >
                    <Icon color={palette.sub} name="server" size={16} />
                    <TextInput
                      accessibilityLabel={t("mobileServerAddress")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      onChangeText={setServer}
                      placeholder={t("mobileServerPlaceholder")}
                      placeholderTextColor={palette.sub}
                      style={[screenStyles.input, { color: palette.ink, fontFamily: fonts.body }]}
                      value={server}
                    />
                  </View>
                </View>
              )}
            </>
          ) : (
            <>
              <Text
                style={[screenStyles.title, { color: palette.authInk, fontFamily: fonts.display }]}
              >
                {t("nativeMobileSignInTeamTitle")}
              </Text>
              <Text
                style={[screenStyles.address, { color: palette.ink, fontFamily: fonts.semibold }]}
              >
                {t("mobileDinghyCloud")}
              </Text>
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
              disabled={disabled}
              onPress={() => void begin()}
              style={({ pressed }) => [
                screenStyles.primary,
                {
                  backgroundColor: isNight ? "#2265d2" : "#155ac9",
                  opacity: disabled ? 0.45 : pressed ? 0.74 : 1,
                },
              ]}
            >
              <Text style={[screenStyles.primaryText, { fontFamily: fonts.semibold }]}>
                {busy ? t("mobileOpeningSignIn") : t("mobileContinueSignIn")}
              </Text>
              <Icon color="#ffffff" name="arrow" size={16} />
            </Pressable>
          )}

          {pending ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void cancel()}
              style={({ pressed }) => [screenStyles.backButton, { opacity: pressed ? 0.64 : 1 }]}
            >
              <Text
                style={[screenStyles.backText, { color: palette.blue, fontFamily: fonts.semibold }]}
              >
                {t("mobileCancelSignIn")}
              </Text>
            </Pressable>
          ) : choosingWorkspace ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSelfHosted(false);
                setChoosingWorkspace(false);
              }}
              style={({ pressed }) => [screenStyles.backButton, { opacity: pressed ? 0.64 : 1 }]}
            >
              <Text
                style={[screenStyles.backText, { color: palette.blue, fontFamily: fonts.semibold }]}
              >
                {t("nativeMobileSignInUseCloud")}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setChoosingWorkspace(true)}
              style={({ pressed }) => [screenStyles.backButton, { opacity: pressed ? 0.64 : 1 }]}
            >
              <Text
                style={[screenStyles.backText, { color: palette.blue, fontFamily: fonts.semibold }]}
              >
                {t("nativeMobileSignInChangeWorkspace")}
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const screenStyles = StyleSheet.create({
  page: { flex: 1 },
  content: { flexGrow: 1 },
  scene: { flex: 1, minHeight: 190, position: "relative", overflow: "hidden" },
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
  card: {
    marginTop: -12,
    marginHorizontal: 10,
    marginBottom: 3,
    borderRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 19,
    shadowColor: "#0b2239",
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  title: { fontSize: 32, lineHeight: 34, letterSpacing: -1.2, marginBottom: 7 },
  copy: { fontSize: 14, lineHeight: 20, marginBottom: 15 },
  address: { fontSize: 14, lineHeight: 20, marginBottom: 15 },
  tabs: {
    flexDirection: "row",
    gap: 2,
    padding: 3,
    borderWidth: 1,
    borderRadius: 999,
    marginBottom: 13,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  tabText: { fontSize: 13 },
  fieldLabel: { fontSize: 13, marginBottom: 6 },
  field: {
    minHeight: 47,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 13,
  },
  input: { flex: 1, minWidth: 0, minHeight: 45, fontSize: 15, paddingVertical: 0 },
  error: { fontSize: 13, lineHeight: 18, marginTop: 10 },
  primary: {
    width: "100%",
    minHeight: 46,
    marginTop: 8,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
  },
  primaryText: { color: "#ffffff", fontSize: 15 },
  backButton: {
    width: "100%",
    minHeight: 42,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  backText: { fontSize: 13 },
});
