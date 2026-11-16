/** @jsxImportSource react */
import { useId, useState } from "react";
import type { CampaignDefinition, OutboundStatusReason } from "./api.ts";
import { definitionJson, upsertCode } from "./campaign-draft.ts";
import { sendCode } from "./campaign-trigger.tsx";
import { CodeBlock } from "./install.tsx";
import { reasonText } from "./outbound.tsx";
import { t } from "./text.ts";
import { Choices, Modal } from "./ui.tsx";

// The campaign editor's dialogs: its code, and what a test did.

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
  const sdk =
    definition.trigger.type === "api"
      ? `${upsertCode(definition)}\n\n${sendCode(definition.key)}`
      : upsertCode(definition);
  return (
    <Modal className="dialog code-dialog" labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignCode")}</h2>
          <p className="dialog-text">{t("campaignCodeHelp")}</p>
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
            <CodeBlock value={sdk} language="ts" title="@dinghy-chat/sdk" />
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
