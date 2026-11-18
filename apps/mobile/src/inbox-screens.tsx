import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import type { PendingReply } from "../outbox";
import { Avatar, initials, visitorName } from "./common";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { inboxStyles as screen } from "./inbox-styles";
import type { PushStatus } from "./notifications";
import type { Palette } from "./theme";
import type { Conversation, Me, Session } from "./types";

type Scope = "all" | "mine" | "unassigned";
type Group = "needsReply" | "teammates" | "waiting" | "bot";

const groupOrder: Group[] = ["needsReply", "teammates", "waiting", "bot"];

function waitLabel(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("mobileWaitNow");
  if (minutes < 60) return t("mobileWaitMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t("mobileWaitHours", { count: hours })
    : t("mobileWaitDays", { count: Math.floor(hours / 24) });
}

function lastActivity(conversation: Conversation): string {
  return conversation.lastMessage?.createdAt ?? conversation.updatedAt;
}

function isLate(conversation: Conversation): boolean {
  return Date.now() - Date.parse(lastActivity(conversation)) >= 10 * 60_000;
}

function lineColor(palette: Palette): string {
  return palette.paper === "#fdfefd" ? "#c8d4d4" : "#465965";
}

function isWaiting(conversation: Conversation): boolean {
  return (
    conversation.status === "open" &&
    conversation.snooze === null &&
    conversation.lastMessage?.fromVisitor === true
  );
}

function groupFor(conversation: Conversation, meId: string): Group {
  if (conversation.assigneeOperatorId !== null && conversation.assigneeOperatorId !== meId) {
    return "teammates";
  }
  if (isWaiting(conversation)) return "needsReply";
  if (conversation.handler?.kind === "bot") return "bot";
  return "waiting";
}

function isInScope(conversation: Conversation, scope: Scope, meId: string): boolean {
  if (scope === "mine") return conversation.assigneeOperatorId === meId;
  if (scope === "unassigned") return conversation.assigneeOperatorId === null;
  return true;
}

function normalized(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLocaleLowerCase();
}

function rowText(conversation: Conversation): { subject: string; preview: string | null } {
  const body = conversation.lastMessage?.body?.trim() ?? "";
  const suppliedSubject = conversation.subject?.trim() ?? "";
  if (!suppliedSubject) {
    const [first = "", ...rest] = body.split(/\r?\n/);
    const preview = rest.join(" ").trim();
    return {
      subject: first || t("mobileAttachment"),
      preview: preview && normalized(preview) !== normalized(first) ? preview : null,
    };
  }
  const bodyLines = body.split(/\r?\n/);
  const withoutSubject =
    normalized(bodyLines[0] ?? "") === normalized(suppliedSubject)
      ? bodyLines.slice(1).join(" ").trim()
      : body;
  return {
    subject: suppliedSubject,
    preview:
      withoutSubject && normalized(withoutSubject) !== normalized(suppliedSubject)
        ? withoutSubject
        : null,
  };
}

function ownerLabel(conversation: Conversation, meId: string): string {
  if (conversation.assigneeOperatorId === null) return t("unassigned");
  if (conversation.assigneeOperatorId === meId) return t("mobileHarborYou");
  if (conversation.handler?.kind === "person") return conversation.handler.name;
  return t("handlerTeam");
}

function ConversationRow({
  conversation,
  meId,
  palette,
  onPress,
}: {
  conversation: Conversation;
  meId: string;
  palette: Palette;
  onPress(): void;
}) {
  const name = visitorName(conversation);
  const copy = rowText(conversation);
  const waits = isWaiting(conversation);
  const late = waits && isLate(conversation);
  const botHandoff = conversation.bot != null && conversation.handler?.kind !== "bot";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        screen.conversationRow,
        pressed && { backgroundColor: palette.wash },
      ]}
    >
      <View style={screen.avatarWrap}>
        <Avatar name={name} picture={conversation.visitor.pictureUrl} size={40} palette={palette} />
        {conversation.unread && (
          <View
            accessibilityLabel={t("unread")}
            style={[
              screen.unreadDot,
              { backgroundColor: palette.blue, borderColor: palette.paper },
            ]}
          />
        )}
      </View>
      <View style={[screen.rowCopy, { borderBottomColor: lineColor(palette) }]}>
        <View style={screen.rowNameLine}>
          <Text numberOfLines={1} style={[screen.rowName, { color: palette.ink }]}>
            {name}
          </Text>
          <View style={screen.timeLine}>
            {waits && <Icon name="clock" size={14} color={late ? palette.amber : palette.sub} />}
            <Text style={[screen.rowTime, { color: late ? palette.amber : palette.sub }]}>
              {waitLabel(lastActivity(conversation))}
            </Text>
          </View>
        </View>
        <Text numberOfLines={1} style={[screen.rowSubject, { color: palette.ink }]}>
          {copy.subject}
        </Text>
        {copy.preview !== null && (
          <Text numberOfLines={1} style={[screen.rowPreview, { color: palette.sub }]}>
            {copy.preview}
          </Text>
        )}
        <View style={screen.rowMetaLine}>
          <View style={screen.rowMetaItem}>
            <Icon name="person" size={14} color={palette.sub} />
            <Text numberOfLines={1} style={[screen.rowMeta, { color: palette.sub }]}>
              {ownerLabel(conversation, meId)}
            </Text>
          </View>
          {(conversation.hasReadyDraft || botHandoff) && (
            <View style={screen.rowMetaItem}>
              <Icon
                name={conversation.hasReadyDraft ? "bot" : "hand"}
                size={14}
                color={palette.navy}
              />
              <Text style={[screen.signal, { color: palette.navy }]}>
                {t(
                  conversation.hasReadyDraft ? "mobileHarborDraftReady" : "mobileHarborBotHandoff",
                )}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function WorkspaceHeader({
  me,
  onAccount,
  palette,
  session,
  topInset,
  waiting,
  longest,
}: {
  me: Me | null;
  onAccount(): void;
  palette: Palette;
  session: Session;
  topInset: number;
  waiting: number;
  longest: string | null;
}) {
  const night = useColorScheme() === "dark";
  const workspaceName =
    me?.workspaces.find((workspace) => workspace.workspaceId === session.workspace.id)?.name ??
    session.workspace.name;
  return (
    <View
      style={[
        screen.inboxCover,
        { paddingTop: topInset, backgroundColor: night ? "#162b40" : "#e3f2ee" },
      ]}
    >
      <View pointerEvents="none" style={[screen.harborArt, { top: topInset }]}>
        <Harbor night={night} animated={false} />
      </View>
      <View style={screen.workspaceLine}>
        <Pressable accessibilityRole="button" onPress={onAccount} style={screen.workspaceButton}>
          <View style={screen.workspaceBoatTile}>
            <Image source={require("../assets/boat.png")} style={screen.workspaceBoat} />
          </View>
          <Text
            numberOfLines={1}
            style={[screen.workspaceName, { color: night ? "#f5efe0" : "#142f3c" }]}
          >
            {workspaceName}
          </Text>
          <Icon name="down" size={14} color={night ? "#f5efe0" : "#142f3c"} />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onAccount} style={screen.accountButton}>
          <View style={screen.accountFace}>
            {me?.pictureUrl ? (
              <Avatar name={me.name} picture={me.pictureUrl} size={40} palette={palette} />
            ) : (
              <Text style={screen.accountInitial}>
                {initials(me?.name ?? session.operator.name).slice(0, 1)}
              </Text>
            )}
          </View>
          <View
            style={[
              screen.accountStatus,
              {
                backgroundColor: me?.away ? palette.sub : palette.green,
                borderColor: night ? "#162b40" : "#e3f2ee",
              },
            ]}
          />
        </Pressable>
      </View>
      <View style={screen.inboxHero}>
        <Text style={[screen.inboxTitle, { color: night ? "#f5efe0" : "#142f3c" }]}>
          {t("inbox")}
        </Text>
        <View style={[screen.shiftPill, { backgroundColor: night ? "#162b40" : "#e3f2ee" }]}>
          <View
            style={[screen.shiftDot, { backgroundColor: me?.away ? palette.sub : palette.green }]}
          />
          <Text style={[screen.shiftText, { color: night ? "#d2e1e7" : "#264654" }]}>
            <Text style={{ fontFamily: fonts.semibold, color: night ? "#f5efe0" : "#142f3c" }}>
              {me?.away ? t("statusAway") : t("statusAvailable")}
            </Text>
            {waiting > 0
              ? t("mobileHarborQueue", {
                  count: waiting,
                  longest: longest ?? t("mobileWaitNow"),
                })
              : t("mobileQueueClear")}
          </Text>
        </View>
      </View>
    </View>
  );
}

const scopeLabels: Record<Scope, string> = {
  all: t("mobileHarborAllChats"),
  mine: t("filterMine"),
  unassigned: t("unassigned"),
};

function ScopeTabs({
  palette,
  scope,
  onFilter,
  onScope,
}: {
  palette: Palette;
  scope: Scope;
  onFilter(): void;
  onScope(scope: Scope): void;
}) {
  return (
    <View
      style={[
        screen.scopeTabs,
        { backgroundColor: palette.paper, borderBottomColor: palette.line },
      ]}
    >
      {(["all", "mine", "unassigned"] as const).map((value) => {
        const selected = value === scope;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={value}
            onPress={() => onScope(value)}
            style={screen.scopeTab}
          >
            <Text style={[screen.scopeLabel, { color: selected ? palette.ink : palette.sub }]}>
              {scopeLabels[value]}
            </Text>
            {selected && <View style={screen.scopeSelected} />}
          </Pressable>
        );
      })}
      <Pressable
        accessibilityLabel={t("mobileHarborFilterQueue")}
        accessibilityRole="button"
        hitSlop={10}
        onPress={onFilter}
        style={screen.filterButton}
      >
        <Icon name="filter" size={22} color={palette.sub} />
      </Pressable>
    </View>
  );
}

function FilterSheet({
  palette,
  scope,
  visible,
  onClose,
  onScope,
}: {
  palette: Palette;
  scope: Scope;
  visible: boolean;
  onClose(): void;
  onScope(scope: Scope): void;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={screen.modalVeil}>
        <Pressable
          accessibilityLabel={t("done")}
          accessibilityRole="button"
          onPress={onClose}
          style={screen.modalBackdrop}
        />
        <View style={[screen.filterSheet, { backgroundColor: palette.paper }]}>
          <View style={screen.sheetHandle} />
          <View style={screen.sheetTitleLine}>
            <Text style={[screen.sheetTitle, { color: palette.ink }]}>
              {t("mobileHarborFilterQueue")}
            </Text>
            <Pressable accessibilityLabel={t("done")} hitSlop={12} onPress={onClose}>
              <Icon name="x" size={21} color={palette.ink} />
            </Pressable>
          </View>
          {(["all", "mine", "unassigned"] as const).map((value) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: scope === value }}
              key={value}
              onPress={() => {
                onScope(value);
                onClose();
              }}
              style={[screen.sheetChoice, { borderBottomColor: palette.line }]}
            >
              <Text style={[screen.sheetChoiceText, { color: palette.ink }]}>
                {scopeLabels[value]}
              </Text>
              {scope === value && <Icon name="check" size={20} color={palette.blue} />}
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function sectionLabel(group: Group): string {
  return {
    needsReply: t("mobileHarborNeedsReply"),
    teammates: t("mobileHarborWithTeammates"),
    waiting: t("mobileHarborWaitingVisitor"),
    bot: t("mobileHarborBotHandling"),
  }[group];
}

function SectionHeader({
  count,
  expanded,
  group,
  palette,
  onPress,
}: {
  count: number;
  expanded: boolean;
  group: Group;
  palette: Palette;
  onPress?(): void;
}) {
  const isMain = group === "needsReply";
  const content = (
    <>
      {!isMain && (
        <Icon
          name={group === "teammates" ? "people" : group === "bot" ? "bot" : "chat"}
          size={20}
          color={palette.sub}
        />
      )}
      <Text style={[isMain ? screen.sectionTitle : screen.foldTitle, { color: palette.ink }]}>
        {sectionLabel(group)}
      </Text>
      <Text style={[screen.sectionCount, { color: palette.sub, backgroundColor: palette.wash }]}>
        {count}
      </Text>
      {isMain ? (
        <Text style={[screen.sectionOrder, { color: palette.sub }]}>
          {t("mobileHarborOldestFirst")}
        </Text>
      ) : (
        <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
          <Icon name="next" size={18} color={palette.sub} />
        </View>
      )}
    </>
  );
  if (isMain) return <View style={screen.sectionHeader}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={[screen.foldHeader, { borderBottomColor: palette.line }]}
    >
      {content}
    </Pressable>
  );
}

export function InboxScreen({
  conversations,
  loading,
  me,
  meId,
  palette,
  pending,
  session,
  topInset,
  waiting,
  onAccount,
  onRefresh,
  onOpen,
  onOpenPending,
}: {
  conversations: Conversation[];
  loading: boolean;
  me: Me | null;
  meId: string;
  palette: Palette;
  pending: PendingReply[];
  session: Session;
  topInset: number;
  waiting: number;
  onAccount(): void;
  onSearch(): void;
  onRefresh(): void;
  onOpen(conversation: Conversation): void;
  onOpenPending(conversationId: string): void;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<Group, boolean>>({
    needsReply: true,
    teammates: false,
    waiting: false,
    bot: false,
  });
  const groups = useMemo(() => {
    const result: Record<Group, Conversation[]> = {
      needsReply: [],
      teammates: [],
      waiting: [],
      bot: [],
    };
    for (const conversation of conversations) {
      if (isInScope(conversation, scope, meId))
        result[groupFor(conversation, meId)].push(conversation);
    }
    result.needsReply.sort(
      (left, right) => Date.parse(lastActivity(left)) - Date.parse(lastActivity(right)),
    );
    for (const group of groupOrder.slice(1)) {
      result[group].sort(
        (left, right) => Date.parse(lastActivity(right)) - Date.parse(lastActivity(left)),
      );
    }
    return result;
  }, [conversations, meId, scope]);
  const allWaiting = conversations
    .filter((conversation) => groupFor(conversation, meId) === "needsReply")
    .sort((left, right) => Date.parse(lastActivity(left)) - Date.parse(lastActivity(right)));
  const longest = allWaiting[0] ? waitLabel(lastActivity(allWaiting[0])) : null;
  const pendingByConversation = pending.filter(
    (reply, index) =>
      pending.findIndex((other) => other.conversationId === reply.conversationId) === index,
  );

  return (
    <>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={palette.blue} />
        }
        style={{ backgroundColor: palette.paper }}
        contentContainerStyle={screen.inboxContent}
      >
        <WorkspaceHeader
          longest={longest}
          me={me}
          onAccount={onAccount}
          palette={palette}
          session={session}
          topInset={topInset}
          waiting={waiting}
        />
        <ScopeTabs
          onFilter={() => setFilterOpen(true)}
          onScope={setScope}
          palette={palette}
          scope={scope}
        />
        {pendingByConversation.length > 0 && (
          <View style={[screen.savedReplies, { borderBottomColor: palette.line }]}>
            <Text style={[screen.savedTitle, { color: palette.ink }]}>{t("pageSavedReplies")}</Text>
            {pendingByConversation.map((reply) => {
              const conversation = conversations.find((item) => item.id === reply.conversationId);
              return (
                <Pressable
                  key={reply.conversationId}
                  onPress={() => onOpenPending(reply.conversationId)}
                  style={[screen.savedRow, { backgroundColor: palette.wash }]}
                >
                  <Icon name="clock" size={17} color={palette.amber} />
                  <View style={screen.savedCopy}>
                    <Text numberOfLines={1} style={[screen.savedName, { color: palette.ink }]}>
                      {conversation ? visitorName(conversation) : t("mobileSavedReplyConversation")}
                    </Text>
                    <Text numberOfLines={1} style={[screen.savedBody, { color: palette.sub }]}>
                      {reply.body}
                    </Text>
                  </View>
                  <Icon name="next" size={17} color={palette.sub} />
                </Pressable>
              );
            })}
          </View>
        )}
        {loading && conversations.length === 0 ? (
          <ActivityIndicator color={palette.blue} style={screen.loading} />
        ) : (
          groupOrder.map((group) => (
            <View key={group}>
              <SectionHeader
                count={groups[group].length}
                expanded={expanded[group]}
                group={group}
                onPress={() => setExpanded((current) => ({ ...current, [group]: !current[group] }))}
                palette={palette}
              />
              {expanded[group] &&
                groups[group].map((conversation) => (
                  <ConversationRow
                    conversation={conversation}
                    key={conversation.id}
                    meId={meId}
                    onPress={() => onOpen(conversation)}
                    palette={palette}
                  />
                ))}
              {group === "needsReply" && groups[group].length === 0 && (
                <View style={screen.queueEmpty}>
                  <Image source={require("../assets/boat.png")} style={screen.emptyBoat} />
                  <Text style={[screen.emptyTitle, { color: palette.ink }]}>
                    {t("mobileHarborNothingNeedsReply")}
                  </Text>
                  <Text style={[screen.emptyCopy, { color: palette.sub }]}>
                    {t("mobileHarborCaughtUp")}
                  </Text>
                </View>
              )}
            </View>
          ))
        )}
      </ScrollView>
      <FilterSheet
        onClose={() => setFilterOpen(false)}
        onScope={setScope}
        palette={palette}
        scope={scope}
        visible={filterOpen}
      />
    </>
  );
}

function SecondaryHeader({
  detail,
  title,
  topInset,
}: {
  detail: string;
  palette: Palette;
  title: string;
  topInset: number;
}) {
  const night = useColorScheme() === "dark";
  return (
    <View
      style={[
        screen.secondaryHeader,
        { paddingTop: topInset + 14, backgroundColor: night ? "#162b40" : "#e3f2ee" },
      ]}
    >
      <View pointerEvents="none" style={[screen.harborArt, { top: topInset }]}>
        <Harbor night={night} animated={false} />
      </View>
      <Text style={[screen.secondaryTitle, { color: night ? "#f5efe0" : "#142f3c" }]}>{title}</Text>
      <Text style={[screen.secondaryDetail, { color: night ? "#d2e1e7" : "#264654" }]}>
        {detail}
      </Text>
    </View>
  );
}

export function SearchScreen({
  conversations,
  me,
  palette,
  session,
  topInset,
  onOpen,
}: {
  conversations: Conversation[];
  me: Me | null;
  palette: Palette;
  session: Session;
  topInset: number;
  onOpen(conversation: Conversation): void;
}) {
  const [query, setQuery] = useState("");
  const workspaceName =
    me?.workspaces.find((workspace) => workspace.workspaceId === session.workspace.id)?.name ??
    session.workspace.name;
  const wanted = normalized(query);
  const shown = conversations.filter((conversation) => {
    const copy = rowText(conversation);
    return normalized(
      `${visitorName(conversation)} ${copy.subject} ${copy.preview ?? ""}`,
    ).includes(wanted);
  });
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: palette.paper }}
      contentContainerStyle={screen.secondaryContent}
    >
      <SecondaryHeader
        detail={t("mobileHarborWorkspace", { workspace: workspaceName })}
        palette={palette}
        title={t("searchPlaceholder")}
        topInset={topInset}
      />
      <View
        style={[screen.searchField, { backgroundColor: palette.paper, borderColor: palette.line }]}
      >
        <Icon name="search" size={22} color={palette.sub} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t("mobileHarborSearchInput")}
          placeholderTextColor={palette.sub}
          returnKeyType="search"
          style={[screen.searchInput, { color: palette.ink }]}
          value={query}
        />
      </View>
      {query.trim() === "" ? (
        <Text style={[screen.searchHint, { color: palette.sub }]}>
          {t("mobileHarborSearchHint")}
        </Text>
      ) : shown.length === 0 ? (
        <Text style={[screen.searchHint, { color: palette.sub }]}>
          {t("mobileHarborNoMatches", { query: query.trim() })}
        </Text>
      ) : (
        <View style={screen.searchResults}>
          <Text style={[screen.resultHeading, { color: palette.ink }]}>
            {t("mobileHarborConversations")}
          </Text>
          {shown.map((conversation) => (
            <ConversationRow
              conversation={conversation}
              key={conversation.id}
              meId={session.operator.id}
              onPress={() => onOpen(conversation)}
              palette={palette}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function SettingsRow({
  detail,
  disabled = false,
  icon,
  palette,
  title,
  destructive = false,
  onPress,
}: {
  detail?: string;
  disabled?: boolean;
  icon: "bell" | "arrow";
  palette: Palette;
  title: string;
  destructive?: boolean;
  onPress(): void;
}) {
  const color = destructive ? "#b73a36" : palette.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        screen.settingsRow,
        { borderBottomColor: palette.line, opacity: disabled ? 0.5 : pressed ? 0.72 : 1 },
      ]}
    >
      <Icon name={icon} size={20} color={color} />
      <View style={screen.settingsRowCopy}>
        <Text style={[screen.settingsRowTitle, { color }]}>{title}</Text>
        {detail && <Text style={[screen.settingsRowDetail, { color: palette.sub }]}>{detail}</Text>}
      </View>
      {!destructive && <Icon name="next" size={17} color={palette.sub} />}
    </Pressable>
  );
}

export function SettingsScreen({
  me,
  palette,
  pushStatus,
  session,
  signingOut,
  topInset,
  onAway,
  onEnablePush,
  onSignOut,
}: {
  me: Me | null;
  palette: Palette;
  pushStatus: PushStatus;
  session: Session;
  signingOut: boolean;
  topInset: number;
  onAway(): void;
  onEnablePush(): void;
  onSignOut(): void;
}) {
  const pushCopy = {
    checking: t("mobilePushChecking"),
    enabled: t("mobilePushEnabled"),
    denied: t("mobilePushDenied"),
    unavailable: t("mobilePushUnavailable"),
    error: t("mobilePushError"),
  }[pushStatus];
  const name = me?.name ?? session.operator.name;
  const workspaceName =
    me?.workspaces.find((workspace) => workspace.workspaceId === session.workspace.id)?.name ??
    session.workspace.name;
  return (
    <ScrollView
      style={{ backgroundColor: palette.paper }}
      contentContainerStyle={screen.secondaryContent}
    >
      <SecondaryHeader
        detail={t("mobileHarborWorkspace", { workspace: workspaceName })}
        palette={palette}
        title={t("mobileShiftSettings")}
        topInset={topInset}
      />
      <Pressable
        accessibilityRole="button"
        onPress={onAway}
        style={[screen.shiftCard, { backgroundColor: palette.paper, borderColor: palette.line }]}
      >
        <View style={screen.avatarWrap}>
          <Avatar name={name} picture={me?.pictureUrl ?? null} size={42} palette={palette} />
          <View
            style={[
              screen.unreadDot,
              {
                backgroundColor: me?.away ? palette.sub : palette.green,
                borderColor: palette.paper,
              },
            ]}
          />
        </View>
        <View style={screen.shiftCardCopy}>
          <Text style={[screen.shiftCardName, { color: palette.ink }]}>{name}</Text>
          <Text style={[screen.shiftCardDetail, { color: palette.sub }]}>
            {me?.away ? t("mobileAwayDetail") : t("mobileAvailableDetail")}
          </Text>
        </View>
        <Text style={[screen.availability, { color: palette.navy, backgroundColor: palette.wash }]}>
          {me?.away ? t("statusAway") : t("statusAvailable")}
        </Text>
      </Pressable>
      <View style={screen.settingBlock}>
        <Text style={[screen.settingBlockTitle, { color: palette.ink }]}>
          {t("mobileHarborYourShift")}
        </Text>
        <View style={[screen.settingBlockBody, { borderColor: palette.line }]}>
          <SettingsRow
            detail={pushCopy}
            disabled={pushStatus === "checking" || pushStatus === "unavailable"}
            icon="bell"
            onPress={onEnablePush}
            palette={palette}
            title={t("pageNotifications")}
          />
        </View>
      </View>
      <View style={screen.settingBlock}>
        <Text style={[screen.settingBlockTitle, { color: palette.ink }]}>
          {t("mobileHarborAccount")}
        </Text>
        <View style={[screen.settingBlockBody, { borderColor: palette.line }]}>
          <SettingsRow
            destructive
            disabled={signingOut}
            icon="arrow"
            onPress={onSignOut}
            palette={palette}
            title={signingOut ? t("mobileSigningOut") : t("signOut")}
          />
        </View>
      </View>
    </ScrollView>
  );
}
