import { useEffect, useState } from "react";
import {
  Image,
  Keyboard,
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
import {
  CLOUD_ORIGIN,
  type EmailCodeRequest,
  requestEmailCode,
  verifyEmailCode,
  verifyTotp,
} from "./auth";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { controlShape, type Palette } from "./theme";
import type { Session } from "./types";

type SignInStep = "email" | "email_code" | "totp";

export function SignInScreen({
  palette,
  isNight,
  topInset,
  bottomInset,
  onSignedIn,
}: {
  palette: Palette;
  isNight: boolean;
  topInset: number;
  bottomInset: number;
  onSignedIn(session: Session): void;
}) {
  const [selfHosted, setSelfHosted] = useState(false);
  const [server, setServer] = useState("");
  const [serverFocused, setServerFocused] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [codeFocused, setCodeFocused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [codeRequest, setCodeRequest] = useState<EmailCodeRequest | null>(null);
  const [totpChallenge, setTotpChallenge] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (step !== "email_code" || resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= resendAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [resendAt, step]);

  const serverAddress = selfHosted ? server : CLOUD_ORIGIN;
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1_000));

  const sendCode = async () => {
    if (!email.trim() || (selfHosted && !server.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const request = await requestEmailCode(serverAddress, email);
      setCodeRequest(request);
      setEmailCode("");
      setCodeFocused(false);
      setResendAt(Date.now() + request.resendAfterSeconds * 1_000);
      setNow(Date.now());
      setStep("email_code");
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  const checkEmailCode = async () => {
    if (!codeRequest || !/^\d{6}$/.test(emailCode)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyEmailCode(codeRequest, emailCode);
      if (result.status === "signed_in") {
        onSignedIn(result.session);
        return;
      }
      setTotpChallenge(result.challenge);
      setTotpCode("");
      setCodeFocused(false);
      setStep("totp");
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  const checkTotp = async () => {
    const code = totpCode.trim();
    if (!codeRequest || !totpChallenge || code.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await verifyTotp(codeRequest.origin, totpChallenge, code));
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    Keyboard.dismiss();
    setStep("email");
    setCodeRequest(null);
    setTotpChallenge(null);
    setEmailCode("");
    setTotpCode("");
    setError(null);
  };

  const disabled =
    busy ||
    (step === "email" && (!email.trim() || (selfHosted && !server.trim()))) ||
    (step === "email_code" && !/^\d{6}$/.test(emailCode)) ||
    (step === "totp" && totpCode.trim().length < 6);
  const primaryLabel =
    step === "email"
      ? busy
        ? t("mobileSendingSignInCode")
        : t("mobileSendSignInCode")
      : busy
        ? t("mobileCheckingSignInCode")
        : t("mobileContinueSignIn");
  const water = isNight ? "#28586c" : "#84bec6";
  const controlInk = isNight ? "#eef5f6" : palette.authInk;
  const selectedHost = isNight ? "#315064" : "#ffffff";

  const submit = () => {
    if (disabled) return;
    Keyboard.dismiss();
    if (step === "email") void sendCode();
    else if (step === "email_code") void checkEmailCode();
    else void checkTotp();
  };

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
        <View
          style={[
            screenStyles.scene,
            keyboardVisible && screenStyles.sceneWithKeyboard,
            keyboardVisible && {
              height: Math.max(topInset + 108, 168),
              minHeight: Math.max(topInset + 108, 168),
              maxHeight: Math.max(topInset + 108, 168),
            },
          ]}
        >
          <Harbor night={isNight} variant="sign-in" />
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
        </View>

        <View
          style={[
            screenStyles.panel,
            {
              backgroundColor: palette.authPanel,
              paddingBottom: Math.max(bottomInset, 14) + 10,
            },
          ]}
        >
          <View style={screenStyles.panelContent}>
            {step === "email" && (
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
                  style={[
                    screenStyles.hostLabel,
                    { color: palette.sub, fontFamily: fonts.semibold },
                  ]}
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
                    disabled={busy}
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
                    disabled={busy}
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
                  <SignInField
                    autoCapitalize="none"
                    editable={!busy}
                    focused={serverFocused}
                    icon="server"
                    keyboardType="url"
                    label={t("mobileServerAddress")}
                    onChange={setServer}
                    onFocus={setServerFocused}
                    palette={palette}
                    placeholder={t("mobileServerPlaceholder")}
                    value={server}
                  />
                )}
                <SignInField
                  autoComplete="email"
                  autoCapitalize="none"
                  editable={!busy}
                  focused={emailFocused}
                  icon="mail"
                  keyboardType="email-address"
                  label={t("mobileEmailAddress")}
                  onChange={setEmail}
                  onFocus={setEmailFocused}
                  palette={palette}
                  placeholder={t("mobileEmailPlaceholder")}
                  textContentType="emailAddress"
                  onSubmit={submit}
                  value={email}
                />
              </>
            )}

            {step === "email_code" && codeRequest && (
              <>
                <StepHeading
                  copy={t("mobileEmailCodeCopy", { email: codeRequest.email })}
                  palette={palette}
                  title={t("mobileEmailCodeTitle")}
                />
                <SignInField
                  autoComplete="one-time-code"
                  editable={!busy}
                  focused={codeFocused}
                  icon="mail"
                  keyboardType="number-pad"
                  label={t("mobileEmailCodeLabel")}
                  maxLength={6}
                  onChange={(value) => setEmailCode(value.replace(/\D/g, ""))}
                  onFocus={setCodeFocused}
                  palette={palette}
                  placeholder="123456"
                  secureTextEntry
                  textContentType="oneTimeCode"
                  onSubmit={submit}
                  value={emailCode}
                />
              </>
            )}

            {step === "totp" && (
              <>
                <StepHeading
                  copy={t("mobileTotpCopy")}
                  palette={palette}
                  title={t("mobileTotpTitle")}
                />
                <SignInField
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  editable={!busy}
                  focused={codeFocused}
                  icon="lock"
                  label={t("mobileTotpLabel")}
                  maxLength={32}
                  onChange={setTotpCode}
                  onFocus={setCodeFocused}
                  palette={palette}
                  placeholder={t("mobileTotpPlaceholder")}
                  secureTextEntry
                  textContentType="oneTimeCode"
                  onSubmit={submit}
                  value={totpCode}
                />
              </>
            )}

            {error && (
              <Text
                accessibilityRole="alert"
                style={[
                  screenStyles.error,
                  { color: isNight ? "#ffb3aa" : "#9f2d29", fontFamily: fonts.body },
                ]}
              >
                {error}
              </Text>
            )}

            <Pressable
              accessibilityLabel={primaryLabel}
              accessibilityRole="button"
              accessibilityState={busy ? { busy: true, disabled } : { disabled }}
              disabled={disabled}
              onPress={submit}
              style={({ pressed }) => [
                screenStyles.primary,
                {
                  backgroundColor: isNight ? "#2d75c0" : "#0b5794",
                  opacity: disabled ? 0.45 : pressed ? 0.74 : 1,
                },
              ]}
            >
              <Text style={[screenStyles.primaryText, { fontFamily: fonts.semibold }]}>
                {primaryLabel}
              </Text>
            </Pressable>

            {step === "email_code" && (
              <Pressable
                accessibilityRole="button"
                disabled={busy || resendSeconds > 0}
                onPress={() => void sendCode()}
                style={screenStyles.textButton}
              >
                <Text
                  style={[
                    screenStyles.textButtonLabel,
                    { color: palette.blue, fontFamily: fonts.semibold },
                  ]}
                >
                  {resendSeconds > 0
                    ? t("mobileResendCodeIn", { seconds: resendSeconds })
                    : t("mobileResendCode")}
                </Text>
              </Pressable>
            )}
            {step !== "email" && (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={restart}
                style={screenStyles.textButton}
              >
                <Text
                  style={[
                    screenStyles.textButtonLabel,
                    { color: palette.sub, fontFamily: fonts.semibold },
                  ]}
                >
                  {step === "email_code" ? t("mobileChangeEmail") : t("mobileRestartSignIn")}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function StepHeading({ title, copy, palette }: { title: string; copy: string; palette: Palette }) {
  return (
    <>
      <Text style={[screenStyles.title, { color: palette.authInk, fontFamily: fonts.displayBold }]}>
        {title}
      </Text>
      <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
        {copy}
      </Text>
    </>
  );
}

function SignInField({
  label,
  value,
  placeholder,
  icon,
  focused,
  onFocus,
  onChange,
  palette,
  keyboardType = "default",
  autoCapitalize = "sentences",
  autoComplete,
  textContentType,
  maxLength,
  editable,
  onSubmit,
  secureTextEntry = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  icon: "server" | "mail" | "lock";
  focused: boolean;
  onFocus(value: boolean): void;
  onChange(value: string): void;
  palette: Palette;
  keyboardType?: "default" | "email-address" | "number-pad" | "url";
  autoCapitalize?: "none" | "sentences";
  autoComplete?: "email" | "one-time-code";
  textContentType?: "emailAddress" | "oneTimeCode";
  maxLength?: number;
  editable: boolean;
  onSubmit?(): void;
  secureTextEntry?: boolean;
}) {
  // iOS adds a toolbar above number pads when a return key type is set.
  const returnKeyType = keyboardType === "number-pad" ? undefined : "done";
  return (
    <View style={screenStyles.fieldGroup}>
      <Text
        style={[screenStyles.fieldLabel, { color: palette.authInk, fontFamily: fonts.semibold }]}
      >
        {label}
      </Text>
      <View
        style={[
          screenStyles.field,
          {
            backgroundColor: palette.paper,
            borderColor: focused ? palette.blue : palette.authLine,
          },
        ]}
      >
        <Icon color={palette.sub} name={icon} size={16} />
        <TextInput
          accessibilityLabel={label}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          autoCorrect={false}
          editable={editable}
          keyboardType={keyboardType}
          maxLength={maxLength}
          onBlur={() => onFocus(false)}
          onChangeText={onChange}
          onFocus={() => onFocus(true)}
          onSubmitEditing={onSubmit}
          placeholder={placeholder}
          placeholderTextColor={palette.sub}
          returnKeyType={returnKeyType}
          secureTextEntry={secureTextEntry}
          style={[screenStyles.input, { color: palette.ink, fontFamily: fonts.body }]}
          submitBehavior="blurAndSubmit"
          textContentType={textContentType}
          value={value}
        />
      </View>
    </View>
  );
}

const screenStyles = StyleSheet.create({
  page: { flex: 1 },
  content: { flexGrow: 1 },
  scene: {
    flexGrow: 1,
    flexShrink: 1,
    height: 312,
    minHeight: 260,
    maxHeight: 390,
    position: "relative",
    overflow: "hidden",
  },
  sceneWithKeyboard: { flexGrow: 0, flexShrink: 0 },
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
  panel: {
    flexGrow: 1,
    minHeight: 330,
    marginTop: -24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 28,
    shadowColor: "#0b2239",
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 10,
  },
  panelContent: { width: "100%", maxWidth: 520, alignSelf: "center" },
  title: { fontSize: 34, lineHeight: 38, letterSpacing: -1.2, marginBottom: 10 },
  copy: { maxWidth: 340, fontSize: 15, lineHeight: 22, marginBottom: 20 },
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
  fieldGroup: { marginBottom: 14 },
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
  error: { fontSize: 13, lineHeight: 18, marginBottom: 2 },
  primary: {
    width: "100%",
    minHeight: 52,
    marginTop: 6,
    borderRadius: controlShape.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 17,
  },
  primaryText: { color: "#ffffff", fontSize: 16 },
  textButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  textButtonLabel: { fontSize: 14 },
});
