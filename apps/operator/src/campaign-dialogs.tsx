/** @jsxImportSource react */
import { useId, useState } from "react";
import { CAMPAIGN_NAME_MAX } from "../../../packages/widget/src/shared.ts";
import type { Campaign, CampaignDefinition, OutboundStatusReason } from "./api.ts";
import { definitionJson, upsertCode } from "./campaign-draft.ts";
import { campaignSentence } from "./campaign-summary.ts";
import { sendCode } from "./campaign-trigger.tsx";
import { CodeBlock } from "./install.tsx";
import { reasonText } from "./outbound.tsx";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { Choices, Field, FormDialog, Modal } from "./ui.tsx";

// The campaign's dialogs, from its page or its row in the list: its code, a test, going live, a
// new name, an end and a delete.

const SDK_PACKAGE = "@dinghy-chat/sdk";
const SDK_URL = "https://www.npmjs.com/package/@dinghy-chat/sdk";

/** Why a campaign cannot be deleted, or null when it can: one that sent keeps its results. */
export function deleteBlock(campaign: Campaign): TextId | null {
  if (campaign.totals.sent > 0) return "campaignDeleteSent";
  if (campaign.status === "live") return "campaignDeleteLive";
  return null;
}

/** "Copy as code": the JSON, and the SDK calls that keep it in a repository and send it. */
export function CodeDialog({
  definition,
  onClose,
}: {
  definition: CampaignDefinition;
  onClose(): void;
}) {
  const [shown, setShown] = useState<"json" | "sdk">("json");
  const titleId = useId();
  const [before, after] = t("campaignCodeHelp").split("{sdk}");
  const sdk =
    definition.trigger.type === "api"
      ? `${upsertCode(definition)}\n\n${sendCode(definition.key)}`
      : upsertCode(definition);
  return (
    <Modal className="dialog code-dialog" labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignCode")}</h2>
          <p className="dialog-text">
            {before}
            <a href={SDK_URL} target="_blank" rel="noopener noreferrer">
              {SDK_PACKAGE}
            </a>
            {after}
          </p>
          <Choices<"json" | "sdk">
            label={t("campaignCode")}
            variant="tabs"
            value={shown}
            options={[
              { value: "json", label: "campaignCodeJson" },
              { value: "sdk", label: "campaignCodeSdk" },
            ]}
            onChange={setShown}
          />
          {shown === "json" ? (
            <CodeBlock value={definitionJson(definition)} language="json" title="JSON" />
          ) : (
            <CodeBlock value={sdk} language="ts" title={SDK_PACKAGE} />
          )}
          <div className="dialog-actions">
            <button type="button" className="pill dark" onClick={close}>
              {t("done")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** What "Send a test to me" did, and the rule that would hold a real message now. */
export function TestDialog({
  blockedBy,
  conversationId,
  onOpenConversation,
  onClose,
}: {
  blockedBy: OutboundStatusReason | null;
  conversationId: string | null;
  onOpenConversation(id: string): void;
  onClose(): void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignTestSent")}</h2>
          <p className="dialog-text">{t("campaignTestSentHelp")}</p>
          <p className="note" role="status">
            {blockedBy === null
              ? t("campaignTestClear")
              : t("campaignTestBlocked", { rule: reasonText(blockedBy) })}
          </p>
          <div className="dialog-actions">
            <button type="button" className="pill" onClick={close}>
              {t("close")}
            </button>
            {conversationId !== null && (
              <button
                type="button"
                className="pill dark"
                onClick={() => onOpenConversation(conversationId)}
              >
                {t("contactOpenConversation")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** "Go live?": what the campaign does, before it starts to send. */
export function GoLiveDialog({
  definition,
  onConfirm,
  onClose,
}: {
  definition: CampaignDefinition;
  onConfirm(): void;
  onClose(): void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignLiveTitle", { name: definition.name })}</h2>
          <p className="note">{campaignSentence(definition)}</p>
          <p className="dialog-text">{t("campaignLiveText")}</p>
          <div className="dialog-actions">
            <button type="button" className="pill" onClick={close}>
              {t("cancel")}
            </button>
            <button type="button" className="pill dark" onClick={onConfirm}>
              {t("campaignGoLive")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A new name for a campaign. Its key stays, because code may use it. */
export function RenameDialog({
  name,
  onSave,
  onClose,
}: {
  name: string;
  /** Answers why the save failed, or null. */
  onSave(name: string): Promise<TextId | null>;
  onClose(): void;
}) {
  const [typed, setTyped] = useState(name);
  const [failure, setFailure] = useState<TextId | null>(null);
  return (
    <FormDialog
      title={t("campaignRenameTitle")}
      help={t("campaignRenameHelp")}
      failure={failure}
      submitLabel={t("save")}
      submitDisabled={typed.trim() === ""}
      onSubmit={(close) =>
        void onSave(typed.trim()).then((refused) =>
          refused === null ? close() : setFailure(refused),
        )
      }
      onClose={onClose}
    >
      <Field
        label={t("campaignName")}
        required
        maxLength={CAMPAIGN_NAME_MAX}
        value={typed}
        onChange={setTyped}
      />
    </FormDialog>
  );
}

const ENDINGS = {
  end: { title: "campaignEndTitle", text: "campaignEndText", confirm: "campaignEnd" },
  delete: { title: "campaignDeleteTitle", text: "campaignDeleteText", confirm: "campaignDelete" },
} as const satisfies Record<string, Record<string, TextId>>;

/** "End {name}?" or "Delete {name}?", which cannot be undone. */
export function EndingConfirm({
  kind,
  name,
  onConfirm,
  onCancel,
}: {
  kind: keyof typeof ENDINGS;
  name: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const texts = ENDINGS[kind];
  return (
    <Confirm
      title={t(texts.title, { name })}
      text={t(texts.text)}
      confirm={t(texts.confirm)}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
