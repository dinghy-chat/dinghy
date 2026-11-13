import { type Dispatch, type SetStateAction, useState } from "react";
import type { Conversation, Snooze, WorkspaceApi } from "./api.ts";
import type { Act } from "./message-actions.tsx";
import { toast } from "./toast.tsx";

/**
 * What the operator does to the whole conversation: assign it, label it, close, reopen or snooze
 * it, block its visitor, email its transcript, give it back to the bots, or delete it, which asks
 * first. Each change shows at once.
 */
export function useConversationActions({
  api,
  conversationId,
  act,
  setConversation,
  onChanged,
  onBack,
  onLabelAdded,
}: {
  api: WorkspaceApi;
  conversationId: string;
  act: Act;
  setConversation: Dispatch<SetStateAction<Conversation | null>>;
  onChanged(): void;
  onBack(): void;
  /** The team has a new label, so the labels load again. */
  onLabelAdded(): void;
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

  const showLabel = (labelId: string, added: boolean) =>
    change((current) => ({
      ...current,
      labelIds: added
        ? [...current.labelIds, labelId]
        : current.labelIds.filter((id) => id !== labelId),
    }));

  const setLabel = async (labelId: string, added: boolean) => {
    if (await act(() => api.setLabel(conversationId, labelId, added))) showLabel(labelId, added);
  };

  /** Adds a label to the team, then puts it on this conversation. */
  const addLabel = (name: string) =>
    act(async () => {
      const made = await api.addLabel({ name });
      onLabelAdded();
      await api.setLabel(conversationId, made.id, true);
      showLabel(made.id, true);
    });

  const sendTranscript = async () => {
    if (await act(() => api.sendTranscript(conversationId))) toast("transcriptSent");
  };

  /** True once the change is saved. */
  const setStatus = async (status: "open" | "closed") => {
    if (!(await act(() => api.setStatus(conversationId, status)))) return false;
    // A close ends a snooze, and a reopen starts with none.
    change((current) => ({ ...current, status, snooze: null }));
    return true;
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
    setLabel,
    addLabel,
    sendTranscript,
    setStatus,
    giveBack,
    setSnooze,
  };
}
