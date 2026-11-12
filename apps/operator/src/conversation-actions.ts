import { type Dispatch, type SetStateAction, useState } from "react";
import type { Conversation, Snooze, WorkspaceApi } from "./api.ts";
import type { Act } from "./message-actions.tsx";
import { toast } from "./toast.tsx";

/**
 * What the operator does to the whole conversation: assign it, close, reopen or snooze it, block its
 * visitor, email its transcript or delete it, which asks first. Each change shows at once.
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
    // A close ends a snooze, and a reopen starts with none.
    change((current) => ({ ...current, status, snooze: null }));
  };

  const setSnooze = async (snooze: Snooze | null) => {
    if (!(await act(() => api.setSnooze(conversationId, snooze)))) return;
    change((current) => ({ ...current, snooze }));
  };

  return {
    confirming,
    setConfirming,
    setBlocked,
    remove,
    assign,
    sendTranscript,
    setStatus,
    setSnooze,
  };
}
