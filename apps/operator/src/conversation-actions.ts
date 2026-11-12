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

  /** Picking a person or the team takes the conversation over: a person handles it from now. */
  const assign = async (operatorId: string | null, name: string | null) => {
    if (!(await act(() => api.assign(conversationId, operatorId)))) return;
    const since = new Date().toISOString();
    change((current) => ({
      ...current,
      assigneeOperatorId: operatorId,
      handler:
        operatorId === null || name === null
          ? { kind: "team", since }
          : { kind: "person", operatorId, name, since },
    }));
  };

  const sendTranscript = async () => {
    if (await act(() => api.sendTranscript(conversationId))) toast("transcriptSent");
  };

  const setStatus = async (status: "open" | "closed") => {
    if (!(await act(() => api.setStatus(conversationId, status)))) return;
    change((current) => ({ ...current, status }));
  };

  /** Gives the conversation back to its bot: nobody is assigned, and the bot may answer again. */
  const giveBack = async () => {
    if (!(await act(() => api.giveBack(conversationId)))) return;
    toast("giveBackDone");
    change((current) => ({
      ...current,
      assigneeOperatorId: null,
      handler: current.bot === null ? null : { kind: "bot", ...current.bot },
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
