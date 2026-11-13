/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { encode } from "uqr";
import {
  ApiError,
  checkTwoFactor,
  disableTwoFactor,
  enableTwoFactor,
  type Me,
  newRecoveryCodes,
  signOut,
  startTwoFactor,
} from "./api.ts";
import { AuthPage } from "./scene.tsx";
import { plural, type TextId, t } from "./text.ts";
import { CopyButton, CopyField, ErrorNote, Field, failureText } from "./ui.tsx";

/** The empty modules around the code that a scanner needs, as the QR standard asks. */
const QR_QUIET_MODULES = 4;
const RECOVERY_FILE = "dinghy-recovery-codes.txt";
/** The server's limit once spaces are gone, so a code typed with spaces always fits. */
const CODE_MAX_LENGTH = 40;

/** A refused code: wrong, the session ended after too many, or the server cannot count tries. */
const codeFailure = (failure: unknown): TextId =>
  failureText(failure, {
    400: "twoFactorWrongCode",
    429: "twoFactorLocked",
    503: "twoFactorUnavailable",
  });

/** The QR code as squares that React draws, so no markup from a library goes in as HTML. */
function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { border: QR_QUIET_MODULES });
  const squares = data
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
    .join("");
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("twoFactorQr")}>
      <rect width={size} height={size} fill="#fff" />
      <path d={squares} fill="#000" />
    </svg>
  );
}

/** A code field's state: the code, its error, and the send that clears and sets them. */
function useCode(onSubmit: (code: string) => Promise<void>) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(code.trim());
    } catch (failure) {
      setError(codeFailure(failure));
      setBusy(false);
    }
  };
  return { code, setCode, error, busy, send };
}

/** A form with one code field, its error and its buttons. */
function CodeForm({
  label,
  submit,
  numeric,
  onSubmit,
  onCancel,
}: {
  label: TextId;
  submit: TextId;
  /** Only a 6-digit code, with no recovery code. */
  numeric: boolean;
  onSubmit(code: string): Promise<void>;
  onCancel?(): void;
}) {
  const { code, setCode, error, busy, send } = useCode(onSubmit);
  return (
    <form className="stack" onSubmit={send}>
      <Field
        label={t(label)}
        autoComplete="one-time-code"
        inputMode={numeric ? "numeric" : "text"}
        maxLength={CODE_MAX_LENGTH}
        required
        value={code}
        onChange={setCode}
      />
      <ErrorNote text={error} />
      <div className="actions">
        <button type="submit" className="pill dark" disabled={busy}>
          {t(submit)}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="pill" onClick={onCancel}>
            {t("cancel")}
          </button>
        )}
      </div>
    </form>
  );
}

/** The codes, once, with ways to keep them. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone(): void }) {
  const text = codes.join("\n");
  return (
    <div className="stack" role="status">
      <strong>{t("twoFactorRecoveryTitle")}</strong>
      <p className="hint">{t("twoFactorRecoveryHelp")}</p>
      <ul className="recovery-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <CopyButton
          value={text}
          text={t("twoFactorRecoveryCopy")}
          label={t("twoFactorRecoveryCopy")}
        />
        <a
          className="pill small"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${text}\n`)}`}
          download={RECOVERY_FILE}
        >
          {t("twoFactorRecoveryDownload")}
        </a>
        <button type="button" className="pill small dark" onClick={onDone}>
          {t("twoFactorRecoverySaved")}
        </button>
      </div>
    </div>
  );
}

/** The QR code and the key, then the first code, which turns it on. */
function Setup({
  secret,
  uri,
  onEnabled,
  onCancel,
}: {
  secret: string;
  uri: string;
  onEnabled(recoveryCodes: string[]): void;
  onCancel(): void;
}) {
  return (
    <div className="stack">
      <p className="hint">{t("twoFactorScan")}</p>
      <QrCode text={uri} />
      <CopyField
        hint={t("twoFactorKey")}
        label={t("twoFactorKey")}
        copyLabel={t("twoFactorKeyCopy")}
        value={secret}
      />
      <CodeForm
        label="twoFactorCode"
        submit="twoFactorConfirm"
        numeric
        onSubmit={async (code) => onEnabled((await enableTwoFactor(code)).recoveryCodes)}
        onCancel={onCancel}
      />
    </div>
  );
}

function TurnOff({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const [isLocked, setIsLocked] = useState(false);
  // Too many wrong codes ended the session, so the button leads back to sign-in.
  if (isLocked) {
    return (
      <div className="stack">
        <ErrorNote text="twoFactorLocked" />
        <div className="actions">
          <button type="button" className="pill dark" onClick={onDone}>
            {t("twoFactorSignInAgain")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="hint">{t("twoFactorOffHelp")}</p>
      <CodeForm
        label="twoFactorCodeOrRecovery"
        submit="twoFactorTurnOff"
        numeric={false}
        onSubmit={async (code) => {
          try {
            await disableTwoFactor(code);
          } catch (failure) {
            if (!(failure instanceof ApiError && failure.status === 429)) throw failure;
            setIsLocked(true);
            return;
          }
          onDone();
        }}
        onCancel={onCancel}
      />
    </div>
  );
}

type Step =
  | { kind: "idle" }
  | { kind: "setup"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "new-codes" }
  | { kind: "turning-off" };

/**
 * The Profile row: turn it on with a QR code and a first code, make new recovery codes, or turn it
 * off with a current code.
 */
export function TwoFactorRow({ me, onChanged }: { me: Me; onChanged(): void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<TextId | null>(null);
  const idle = () => setStep({ kind: "idle" });
  const finish = () => {
    idle();
    onChanged();
  };
  const begin = async () => {
    setError(null);
    try {
      setStep({ kind: "setup", ...(await startTwoFactor()) });
    } catch (failure) {
      setError(failureText(failure, {}));
    }
  };
  if (step.kind === "setup") {
    return (
      <Setup
        secret={step.secret}
        uri={step.uri}
        onEnabled={(codes) => setStep({ kind: "codes", codes })}
        onCancel={idle}
      />
    );
  }
  if (step.kind === "codes") return <RecoveryCodes codes={step.codes} onDone={finish} />;
  if (step.kind === "turning-off") return <TurnOff onDone={finish} onCancel={idle} />;
  if (step.kind === "new-codes") {
    return (
      <div className="stack">
        <p className="hint">{t("twoFactorNewCodesHelp")}</p>
        <CodeForm
          label="twoFactorCode"
          submit="twoFactorNewCodesConfirm"
          numeric
          onSubmit={async (code) =>
            setStep({ kind: "codes", codes: (await newRecoveryCodes(code)).recoveryCodes })
          }
          onCancel={idle}
        />
      </div>
    );
  }
  const isOn = me.twoFactor === "on";
  return (
    <div className="stack">
      {isOn && <p className="note">{t("twoFactorIsOn")}</p>}
      {me.recoveryCodesLeft !== null && (
        <p className="hint">
          {plural(me.recoveryCodesLeft, "twoFactorCodesLeftOne", "twoFactorCodesLeftMany")}
        </p>
      )}
      <ErrorNote text={error} />
      <div className="actions">
        {isOn && (
          <button type="button" className="pill" onClick={() => setStep({ kind: "new-codes" })}>
            {t("twoFactorNewCodes")}
          </button>
        )}
        <button
          type="button"
          className={isOn ? "pill" : "pill dark"}
          onClick={isOn ? () => setStep({ kind: "turning-off" }) : () => void begin()}
        >
          {t(isOn ? "twoFactorTurnOff" : "twoFactorTurnOn")}
        </button>
      </div>
    </div>
  );
}

/** After the email link, for an operator with two-step sign-in on: nothing else opens before it. */
export function TwoFactorCheck({
  onPassed,
  onSignedOut,
}: {
  onPassed(): void;
  onSignedOut(): void;
}) {
  const { code, setCode, error, busy, send } = useCode(async (typed) => {
    await checkTwoFactor(typed);
    onPassed();
  });
  // Too many wrong codes ended the session.
  if (error === "twoFactorLocked") {
    return (
      <AuthPage time="noon">
        <ErrorNote text={error} />
        <button type="button" className="btn primary large" onClick={onSignedOut}>
          {t("twoFactorSignInAgain")}
        </button>
      </AuthPage>
    );
  }
  return (
    <AuthPage time="noon" onSubmit={send}>
      <h1>{t("twoFactorCheckTitle")}</h1>
      <p className="note">{t("twoFactorCheckHelp")}</p>
      <Field
        label={t("twoFactorCodeOrRecovery")}
        autoComplete="one-time-code"
        maxLength={CODE_MAX_LENGTH}
        required
        value={code}
        onChange={setCode}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t("twoFactorCheckButton")}
      </button>
      <button
        type="button"
        className="btn link"
        onClick={() => void signOut().finally(onSignedOut)}
      >
        {t("signOut")}
      </button>
    </AuthPage>
  );
}
