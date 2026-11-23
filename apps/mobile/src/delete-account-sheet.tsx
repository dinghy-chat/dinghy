import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { ApiError, type DinghyApi } from "./api";
import { readableError } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { Sheet } from "./sheet";
import type { Palette } from "./theme";
import type { Me } from "./types";

/** The words for a refused delete. The server's own message covers the other refusals. */
function deleteError(failure: unknown): string {
  if (failure instanceof ApiError) {
    if (failure.code === "last_workspace") return t("deleteAccountLastWorkspace");
    if (failure.code === "email_mismatch") return t("emailMismatch");
    if (failure.code === "team_changed") return t("teamChanged");
    if (failure.code === "billing_unavailable") return t("billingUnavailable");
  }
  return readableError(failure);
}

type Mode = Me["deleteConfirmation"];

/**
 * The operator deletes their account. The sheet first lists what they lose, with what happens to
 * each workspace they alone own, from a fresh read of the account. They then type their email. A
 * server with a mail server emails a link that deletes the account, and one without deletes it at
 * once.
 */
export function DeleteAccountSheet({
  visible,
  onClose,
  api,
  me,
  palette,
  onDeleted,
  onSessionEnded,
}: {
  visible: boolean;
  onClose(): void;
  api: DinghyApi;
  me: Me;
  palette: Palette;
  /** The account is gone, and this phone signs out. */
  onDeleted(): void;
  /** The session ended before the delete, so the phone signs out as after any ended session. */
  onSessionEnded(failure: ApiError): void;
}) {
  // Null until the server answers. The sheet never guesses, because the two modes warn
  // differently: a wrong guess could delete at once behind "Email me the link".
  const [mode, setMode] = useState<Mode | null>(null);
  const [account, setAccount] = useState(me);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  // A late answer after the sheet's app unmounted, as after a sign-out and a new sign-in, does
  // nothing, so it cannot end the new session.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reloads after a failure.
  useEffect(() => {
    if (!visible) return;
    setMode(null);
    setLoadFailed(false);
    setTyped("");
    setSent(false);
    setError("");
    let active = true;
    void api.me().then(
      (fresh) => {
        if (!active) return;
        setMode(fresh.deleteConfirmation);
        setAccount(fresh);
      },
      (failure: unknown) => {
        if (!active) return;
        if (failure instanceof ApiError && failure.status === 401) {
          onSessionEnded(failure);
          return;
        }
        setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, visible, attempt]);
  const owned = account.workspaces.filter((one) => one.soleOwner);
  const matches = typed.trim().toLowerCase() === account.email.toLowerCase();
  const canSubmit = mode !== null && matches && !busy && !sent;
  const action = mode === "email" ? t("deleteAccountSend") : t("deleteAccountButton");
  function close() {
    if (busy) return;
    Keyboard.dismiss();
    onClose();
  }
  async function submit() {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setError("");
    try {
      const { deleted } = await api.deleteAccount(typed.trim());
      if (!mounted.current) return;
      if (deleted) {
        onDeleted();
        return;
      }
      setSent(true);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) {
        onSessionEnded(failure);
        return;
      }
      setError(deleteError(failure));
    } finally {
      submitting.current = false;
    }
    setBusy(false);
  }
  return (
    <Sheet visible={visible} onClose={close} dismissible={!busy} palette={palette}>
      <View style={s.bar}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          hitSlop={6}
          onPress={close}
          style={({ pressed }) => [s.barButton, pressed && s.pressed]}
        >
          <Text style={[s.barText, { color: palette.blue }]}>{sent ? t("done") : t("cancel")}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={[s.barTitle, { color: palette.ink }]}>
          {sent ? t("mobileDeleteAccountSentTitle") : t("deleteAccountConfirmTitle")}
        </Text>
        <View style={s.barButton} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={s.body}
      >
        {sent ? (
          <Text accessibilityRole="alert" style={[s.text, { color: palette.ink }]}>
            {t("deleteAccountSent", { email: account.email })}
          </Text>
        ) : (
          <>
            <Text style={[s.text, { color: palette.ink }]}>{t("mobileDeleteAccountSummary")}</Text>
            {owned.length > 0 && (
              <View style={[s.card, { backgroundColor: palette.wash }]}>
                {owned.map((one, index) => (
                  <View key={one.workspaceId}>
                    {index > 0 && <View style={[s.divider, { backgroundColor: palette.line }]} />}
                    <View style={s.outcome}>
                      <Icon
                        name={one.heir === null ? "trash" : "person"}
                        size={18}
                        color={one.heir === null ? palette.danger : palette.sub}
                      />
                      <Text style={[s.outcomeText, { color: palette.ink }]}>
                        {one.heir === null
                          ? t("mobileDeleteAccountWorkspaceGoes", { name: one.name })
                          : t("mobileDeleteAccountWorkspacePasses", {
                              name: one.name,
                              heir: one.heir,
                            })}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
            {loadFailed ? (
              <View style={s.checking}>
                <Text style={[s.text, s.flex, { color: palette.danger }]}>
                  {t("mobileDeleteAccountCheckFailed")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => setAttempt((value) => value + 1)}
                  style={({ pressed }) => [s.retry, pressed && s.pressed]}
                >
                  <Text style={[s.barText, { color: palette.blue }]}>{t("mobileRetry")}</Text>
                </Pressable>
              </View>
            ) : (
              mode === null && (
                <View style={s.checking}>
                  <ActivityIndicator color={palette.sub} />
                  <Text style={[s.text, s.flex, { color: palette.sub }]}>
                    {t("mobileDeleteAccountChecking")}
                  </Text>
                </View>
              )
            )}
            {mode !== null && (
              <>
                <Text style={[s.label, { color: palette.ink }]}>
                  {t("deleteAccountType", { email: account.email })}
                </Text>
                {/* No submit from the keyboard: only the labeled button deletes. */}
                <TextInput
                  accessibilityLabel={t("deleteAccountType", { email: account.email })}
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  editable={!busy}
                  enterKeyHint="done"
                  inputMode="email"
                  keyboardType="email-address"
                  onChangeText={setTyped}
                  placeholder={account.email}
                  placeholderTextColor={palette.sub}
                  returnKeyType="done"
                  selectionColor={palette.blue}
                  style={[s.input, { backgroundColor: palette.wash, color: palette.ink }]}
                  textContentType="emailAddress"
                  value={typed}
                />
              </>
            )}
            {error !== "" && (
              <Text accessibilityRole="alert" style={[s.text, { color: palette.danger }]}>
                {error}
              </Text>
            )}
            <Pressable
              accessibilityLabel={action}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy }}
              disabled={!canSubmit}
              onPress={() => void submit()}
              style={({ pressed }) => [
                s.button,
                {
                  backgroundColor: palette.danger,
                  opacity: canSubmit ? (pressed ? 0.72 : 1) : 0.42,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={palette.paper} />
              ) : (
                <Text style={[s.buttonText, { color: palette.paper }]}>{action}</Text>
              )}
            </Pressable>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

const s = StyleSheet.create({
  bar: { minHeight: 48, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  barButton: { minWidth: 72, minHeight: 44, paddingHorizontal: 12, justifyContent: "center" },
  barText: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 22 },
  barTitle: {
    flex: 1,
    textAlign: "center",
    fontFamily: fonts.semibold,
    fontSize: 17,
    lineHeight: 22,
  },
  pressed: { opacity: 0.6 },
  body: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, gap: 14 },
  text: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  flex: { flex: 1, minWidth: 0 },
  checking: { flexDirection: "row", alignItems: "center", gap: 10 },
  card: { borderRadius: 14, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  outcome: {
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  outcomeText: { flex: 1, minWidth: 0, fontFamily: fonts.body, fontSize: 15, lineHeight: 20 },
  label: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20 },
  input: {
    minHeight: 50,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonText: { fontFamily: fonts.semibold, fontSize: 16 },
  retry: { minHeight: 44, justifyContent: "center" },
});
