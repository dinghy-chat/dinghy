// What the Inbox shows and keeps current: the live stream of changes and its chime, the team, who
// has which conversation open, and the list of conversations for the chosen filter.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ApiError,
  type Conversation,
  type Member,
  type OpenCounts,
  type WorkspaceApi,
} from "./api.ts";
import { type Filter, WHO_ASSIGNEE, type Who } from "./inbox-filters.tsx";
import { useChanges, usePresence, useTabVisible } from "./live.ts";
import { useLiveCount, useWaitingBy } from "./live-counts.ts";
import { useLatestLoad } from "./load.ts";
import { chime, prepareSound } from "./sound.ts";
import { readStored, store } from "./stored.ts";
import { useWaitingBadge } from "./tab-badge.ts";
import { t } from "./text.ts";

const PAGE_SIZE = 50;

/** Whether this browser already did something once. Without storage, it reads as no. */
const remembered = (key: string) => readStored(key) !== null;
const remember = (key: string) => store(key, "1");

/**
 * The live stream, with a chime for a visitor's message in a conversation the operator is not
 * looking at, and the live counts beside it.
 */
function useLive(api: WorkspaceApi, shownConversation: string | null, onSignedOut: () => void) {
  const visible = useTabVisible();
  useEffect(prepareSound, []);
  const shown = useRef(shownConversation);
  useLayoutEffect(() => {
    shown.current = shownConversation;
  });
  const onVisitorMessage = useCallback((conversationId: string | null) => {
    const looking = document.visibilityState === "visible" && document.hasFocus();
    if (!looking || conversationId !== shown.current) chime();
  }, []);
  const changes = useChanges(api, visible, onSignedOut, onVisitorMessage);
  const liveCount = useLiveCount(api, visible);
  const waitingElsewhere = useWaitingBy(visible);
  return { visible, liveCount, waitingElsewhere, ...changes };
}

/** The team, loaded again when it changes, and who else has a conversation open, by name. */
function useTeam(
  api: WorkspaceApi,
  meId: string,
  selected: string | null,
  visible: boolean,
  teamVersion: number,
) {
  const [members, setMembers] = useState<Member[]>([]);
  const loadMembers = useLatestLoad(async () => {
    setMembers((await api.members()).members);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: teamVersion asks for a load.
  useEffect(loadMembers, [loadMembers, teamVersion]);
  const { viewers, leave } = usePresence(api, selected, visible);
  /** Who else has this conversation open, by name. Someone who left the team has no name here. */
  const replying = (conversationId: string) => {
    const names = (viewers[conversationId] ?? [])
      .filter((id) => id !== meId)
      .flatMap((id) => members.find((member) => member.id === id)?.name ?? []);
    if (names.length === 0) return null;
    return t(names.length === 1 ? "isReplying" : "areReplying", { names: names.join(", ") });
  };
  return { members, loadMembers, replying, leavePresence: leave };
}

/**
 * The conversations for a filter, a page at a time. A new filter starts at its first page without
 * the old filter's rows. A new workspace's first open list holds only the welcome chat, which opens
 * by itself, once.
 */
function useConversationList({
  api,
  workspaceId,
  filter,
  who,
  version,
  onSignedOut,
  onWelcome,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  filter: Filter;
  who: Who;
  version: number;
  onSignedOut(): void;
  onWelcome(conversationId: string): void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // The first page has arrived, so an empty list means an empty inbox and not one still loading.
  const [listed, setListed] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [listedFilter, setListedFilter] = useState(filter);
  if (listedFilter !== filter) {
    setListedFilter(filter);
    setLimit(PAGE_SIZE);
    setConversations([]);
    setListed(false);
  }
  const [waiting, setWaiting] = useState(0);
  const [openBy, setOpenBy] = useState<OpenCounts | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { status } = filter;
  const assignee = WHO_ASSIGNEE[who];
  const shown = useRef({ status, assignee, limit });
  useLayoutEffect(() => {
    shown.current = { status, assignee, limit };
  });
  const firstList = useRef(true);
  const welcomeKey = `dinghy.welcome-opened.${workspaceId}`;
  const reload = useLatestLoad(async () => {
    const wanted = shown.current;
    try {
      const moved = () =>
        wanted.status !== shown.current.status || wanted.assignee !== shown.current.assignee;
      const page = await api.list(wanted.status, wanted.assignee, wanted.limit, moved);
      // The operator may have picked another filter while this was on its way.
      if (moved()) return;
      setConversations(page.conversations);
      setListed(true);
      setHasMore(page.hasMore);
      setWaiting(page.waiting);
      setOpenBy(page.openBy);
      if (firstList.current && wanted.status === "open" && wanted.assignee === null) {
        firstList.current = false;
        const [only, ...rest] = page.conversations;
        if (only?.welcome && rest.length === 0 && !remembered(welcomeKey)) {
          remember(welcomeKey);
          onWelcome(only.id);
        }
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onSignedOut();
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: each of these asks for a load.
  useEffect(reload, [reload, status, assignee, limit, version]);
  const loadMore = () => setLimit((current) => current + PAGE_SIZE);
  return { conversations, listed, waiting, openBy, hasMore, reload, loadMore };
}

/**
 * The Inbox's data, kept live. `shownConversation` is the conversation in view, which a visitor's
 * new message does not chime for.
 */
export function useInboxData({
  api,
  workspaceId,
  meId,
  filter,
  selected,
  shownConversation,
  onSignedOut,
  onAccountChanged,
  onWelcome,
}: {
  api: WorkspaceApi;
  workspaceId: string;
  meId: string;
  filter: Filter;
  selected: string | null;
  shownConversation: string | null;
  onSignedOut(): void;
  /** A workspace's billing, name or logo changed, so `me` must load again. */
  onAccountChanged(): void;
  onWelcome(conversationId: string): void;
}) {
  const live = useLive(api, shownConversation, onSignedOut);
  // The read-only flag is in `me`, so it loads again with the billing state.
  const seenAccountVersion = useRef(live.accountVersion);
  useEffect(() => {
    if (live.accountVersion === seenAccountVersion.current) return;
    seenAccountVersion.current = live.accountVersion;
    onAccountChanged();
  }, [live.accountVersion, onAccountChanged]);
  const team = useTeam(api, meId, selected, live.visible, live.teamVersion);
  // A team of one has nothing to filter. The roster is empty only until it loads, and the
  // address's filter holds until then.
  const isTeam = team.members.length > 1;
  const who: Who = isTeam || team.members.length === 0 ? filter.who : "all";
  const list = useConversationList({
    api,
    workspaceId,
    filter,
    who,
    version: live.version,
    onSignedOut,
    onWelcome,
  });
  // A waiting visitor shows from another tab, and on the installed app's icon. A hidden tab holds
  // no stream, so its list stands still and the minute's count takes over.
  useWaitingBadge(
    live.visible ? list.waiting : (live.waitingElsewhere[workspaceId] ?? list.waiting),
  );
  return { ...live, ...team, ...list, isTeam, who };
}
