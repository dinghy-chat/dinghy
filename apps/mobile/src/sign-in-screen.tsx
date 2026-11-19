import { useEffect, useState } from "react";
import {
  Image,
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
import { Sheet } from "./sheet";
import { controlShape, type Palette } from "./theme";
import type { Session } from "./types";

type SignInStep = "email" | "email_code" | "totp";

export function SignInScreen({
  palette,
  topInset,
  bottomInset,
  onSignedIn,
}: {
  palette: Palette;
  topInset: number;
  bottomInset: number;
  onSignedIn(session: Session): void;
}) {
  const [selfHosted, setSelfHosted] = useState(false);
  const [server, setServer] = useState("");
  const [serverFocused, setServerFocused] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [codeFocused, setCodeFocused] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const { width, height } = useWindowDimensions();
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
  const submit = () => {
    if (disabled) return;
    Keyboard.dismiss();
    if (step === "email") void sendCode();
    else if (step === "email_code") void checkEmailCode();
    else void checkTotp();
  };

  return (
    <View style={screenStyles.page}>
      <Image
        accessible={false}
        resizeMode="cover"
        source={
          width > height
            ? require("../assets/sign-in-morning.png")
            : require("../assets/sign-in-portrait.png")
        }
        style={screenStyles.background}
      />
      <View
        style={[
          screenStyles.landing,
          { paddingTop: topInset + 12, paddingBottom: Math.max(bottomInset, 16) + 8 },
        ]}
      >
        <View>
          <View style={screenStyles.wordmark}>
            <View style={screenStyles.boatMark}>
              <Image
                accessible={false}
                source={require("../assets/boat.png")}
                style={screenStyles.boat}
                resizeMode="contain"
              />
            </View>
            <Text
              style={[screenStyles.brand, { color: palette.authInk, fontFamily: fonts.display }]}
            >
              {t("appName")}
            </Text>
          </View>
          <Text
            accessibilityRole="header"
            style={[screenStyles.headline, height < 500 && screenStyles.compactHeadline]}
          >
            {t("mobileWelcomeHeadline")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setFormOpen(true)}
          style={({ pressed }) => [screenStyles.entryButton, { opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={screenStyles.entryLabel}>{t("linkSignIn")}</Text>
        </Pressable>
      </View>
      <Sheet
        visible={formOpen}
        onClose={() => {
          Keyboard.dismiss();
          setFormOpen(false);
        }}
        palette={palette}
        bottomInset={bottomInset}
        title={
          step === "email"
            ? t("linkSignIn")
            : step === "email_code"
              ? t("mobileEmailCodeTitle")
              : t("mobileTotpTitle")
        }
      >
        <ScrollView
          bounces={false}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={screenStyles.panelContent}
        >
          {step === "email" && (
            <>
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
                  disabled={busy}
                  onPress={() => setSelfHosted(false)}
                  style={[screenStyles.tab, !selfHosted && { backgroundColor: palette.sheet }]}
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
                  style={[screenStyles.tab, selfHosted && { backgroundColor: palette.sheet }]}
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
              <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("mobileEmailCodeCopy", { email: codeRequest.email })}
              </Text>
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
              <Text style={[screenStyles.copy, { color: palette.sub, fontFamily: fonts.body }]}>
                {t("mobileTotpCopy")}
              </Text>
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
              style={[screenStyles.error, { color: "#9f2d29", fontFamily: fonts.body }]}
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
                backgroundColor: "#0b2239",
                opacity: disabled ? 0.54 : pressed ? 0.74 : 1,
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
        </ScrollView>
      </Sheet>
    </View>
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
          keyboardAppearance="light"
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
  page: { flex: 1, backgroundColor: "#fff3c4" },
  background: { ...StyleSheet.absoluteFill, width: "100%", height: "100%" },
  landing: {
    flex: 1,
    justifyContent: "space-between",
    alignSelf: "center",
    width: "100%",
    maxWidth: 600,
    paddingHorizontal: 24,
  },
  entryButton: {
    minHeight: 54,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff8df",
    borderRadius: controlShape.pill,
  },
  entryLabel: { color: "#0b2239", fontFamily: fonts.semibold, fontSize: 18 },
  headline: {
    maxWidth: 330,
    marginTop: 24,
    color: "#0b2239",
    fontFamily: fonts.displayBold,
    fontSize: 36,
    lineHeight: 39,
    letterSpacing: -1,
  },
  compactHeadline: { maxWidth: 440, fontSize: 26, lineHeight: 30, marginTop: 8 },
  wordmark: {
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
  panelContent: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
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
