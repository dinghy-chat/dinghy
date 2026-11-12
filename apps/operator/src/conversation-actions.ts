import { type Dispatch, type SetStateAction, useState } from "react";
import type { Conversation, WorkspaceApi } from "./api.ts";
import type { Act } from "./message-actions.tsx";
import { toast } from "./toast.tsx";

/**
 * What the operator does to the whole conversation: assign it, close or reopen it, block its
 * visitor, email its transcript, give it back to the bots, or delete it, which asks first. Each
 * change shows at once.
 */
export function useConversationActions({
  api,
  conversationId,
  act,
  setConversation,
  onChanged,
  onBack,
}: {
  api: WorkspaceApi;
  conversationId: string;
  act: Act;
  setConversation: Dispatch<SetStateAction<Conversation | null>>;
  onChanged(): void;
  onBack(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const change = (patch: (current: Conversation) => Conversation) => {
    setConversation((current) => (current === null ? current : patch(current)));
    onChanged();
  };

  const setBlocked = async (blocked: boolean) => {
    if (!(await act(() => (blocked ? api.block(conversationId) : api.unblock(conversationId))))) {
      return;
    }
    change((current) => ({ ...current, visitor: { ...current.visitor, blocked } }));
  };

  const remove = async () => {
    if (!(await act(() => api.remove(conversationId), { fallback: "deleteFailed" }))) {
      setConfirming(false);
      return;
    }
    onChanged();
    onBack();
  };

  const assign = async (operatorId: string | null) => {
    if (!(await act(() => api.assign(conversationId, operatorId)))) return;
    change((current) => ({ ...current, assigneeOperatorId: operatorId }));
  };

  const sendTranscript = async () => {
    if (await act(() => api.sendTranscript(conversationId))) toast("transcriptSent");
  };

  const setStatus = async (status: "open" | "closed") => {
    if (!(await act(() => api.setStatus(conversationId, status)))) return;
    change((current) => ({ ...current, status }));
  };

  const giveBack = async () => {
    if (!(await act(() => api.giveBack(conversationId)))) return;
    toast("giveBackDone");
    // No person handles it now. The next load names the bot.
    change((current) => ({
      ...current,
      handler: current.handler?.kind === "bot" ? current.handler : null,
    }));
  };

  return {
    confirming,
    setConfirming,
    setBlocked,
    remove,
    assign,
    sendTranscript,
    setStatus,
    giveBack,
  };
}
