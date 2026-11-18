import { useEffect, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import { beginSignIn, CLOUD_ORIGIN, cancelPendingSignIn, hasPendingSignIn } from "./auth";
import { PillButton, readableError } from "./common";
import { type Palette, styles } from "./theme";

export function SignInScreen({
  palette,
  isNight,
  completionError,
  onStart,
}: {
  palette: Palette;
  isNight: boolean;
  completionError: string | null;
  onStart(): void;
}) {
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

  return (
    <View style={[styles.auth, { backgroundColor: palette.authPanel }]}>
      <View style={styles.harbor}>
        <Harbor animated night={isNight} paused={!animated} />
        <View style={styles.brand}>
          <Image
            source={require("../assets/boat.png")}
            style={styles.brandBoat}
            resizeMode="contain"
          />
          <Text style={[styles.brandText, { color: isNight ? "#fffdf7" : palette.authInk }]}>
            {t("appName")}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={animated ? t("mobilePauseHarbor") : t("mobilePlayHarbor")}
          onPress={() => setAnimated((value) => !value)}
          style={styles.motionButton}
        >
          <Text style={styles.motionButtonText}>{animated ? "Ⅱ" : "▶"}</Text>
        </Pressable>
      </View>
      <View style={[styles.authCard, { backgroundColor: palette.authPanel }]}>
        <Text style={[styles.authTitle, { color: palette.authInk }]}>{t("signInTitle")}</Text>
        <Text style={[styles.authCopy, { color: palette.sub }]}>{t("mobileSignInCopy")}</Text>
        <View style={[styles.authTabs, { borderColor: palette.authLine }]}>
          <Pressable
            onPress={() => setSelfHosted(false)}
            style={[styles.authTab, !selfHosted && { backgroundColor: palette.tint }]}
          >
            <Text style={[styles.authTabText, { color: !selfHosted ? palette.blue : palette.sub }]}>
              {t("mobileDinghyCloud")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSelfHosted(true)}
            style={[styles.authTab, selfHosted && { backgroundColor: palette.tint }]}
          >
            <Text style={[styles.authTabText, { color: selfHosted ? palette.blue : palette.sub }]}>
              {t("mobileSelfHosted")}
            </Text>
          </Pressable>
        </View>
        {selfHosted && (
          <View>
            <Text style={[styles.fieldLabel, { color: palette.authInk }]}>
              {t("mobileServerAddress")}
            </Text>
            <TextInput
              accessibilityLabel={t("mobileServerAddress")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setServer}
              placeholder={t("mobileServerPlaceholder")}
              placeholderTextColor="#82939c"
              style={[styles.authInput, { borderColor: palette.authLine, color: palette.authInk }]}
              value={server}
            />
          </View>
        )}
        {(error ?? completionError) && (
          <Text style={[styles.authError, { color: isNight ? "#ffb3aa" : "#9f2d29" }]}>
            {error ?? completionError}
          </Text>
        )}
        <PillButton
          disabled={busy || pending}
          label={
            busy
              ? t("mobileOpeningSignIn")
              : pending
                ? t("mobileWaitingBrowser")
                : t("mobileContinueSignIn")
          }
          onPress={begin}
          palette={palette}
          primary
        />
        {pending && (
          <View style={styles.authCancel}>
            <PillButton
              label={t("mobileCancelSignIn")}
              onPress={() => void cancel()}
              palette={palette}
            />
          </View>
        )}
      </View>
    </View>
  );
}
