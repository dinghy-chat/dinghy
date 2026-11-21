import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { plainText } from "../../../packages/widget/src/markdown.ts";
import { t } from "../../operator/src/text.ts";
import { Harbor } from "../Harbor";
import type { PendingReply } from "../outbox";
import { AdminTools } from "./AdminTools";
import type { ApiError, DinghyApi } from "./api";
import { Avatar, elapsedLabel, readableError, visitorName } from "./common";
import { DeleteAccountSheet } from "./delete-account-sheet";
import { fonts } from "./fonts";
import { Icon } from "./icon";
import { inboxStyles as screen } from "./inbox-styles";
import type { PushStatus } from "./notifications";
import { ProfileSheet } from "./profile-sheet";
import { MovingPatch } from "./scene-motion";
import { Sheet } from "./sheet";
import { useTabBarInset } from "./tab-bar-inset";
import { night, type Palette, type ThemePreference } from "./theme";
import type { AlertSettings, Conversation, Me, Member, SavedReply, Session } from "./types";

type Scope = "all" | "mine" | "unassigned";
type Group = "needsReply" | "teammates" | "waiting" | "bot";

const groupOrder: Group[] = ["needsReply", "teammates", "waiting", "bot"];

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
  const body = plainText(conversation.lastMessage?.body ?? "");
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
              {elapsedLabel(lastActivity(conversation))}
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
  const workspace = me?.workspaces.find((item) => item.workspaceId === session.workspace.id);
  const workspaceName = workspace?.name ?? session.workspace.name;
  return (
    <View style={[screen.inboxCover, { paddingTop: topInset, backgroundColor: palette.cover }]}>
      <View pointerEvents="none" style={[screen.harborArt, { top: topInset }]}>
        <Harbor night={palette === night} shore={palette.paper} moving />
      </View>
      <View style={screen.workspaceLine}>
        <View style={screen.workspaceButton}>
          <Avatar
            kind="workspace"
            name={workspaceName}
            picture={workspace?.logoUrl ?? null}
            size={32}
            palette={palette}
          />
          <Text numberOfLines={1} style={[screen.workspaceName, { color: palette.coverInk }]}>
            {workspaceName}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={t("settings")}
          accessibilityRole="button"
          onPress={onAccount}
          style={screen.accountButton}
        >
          <Avatar
            name={me?.name ?? session.operator.name}
            picture={me?.pictureUrl ?? null}
            size={40}
            palette={palette}
          />
          <View
            style={[
              screen.accountStatus,
              {
                backgroundColor: me?.away ? palette.sub : palette.green,
                borderColor: palette.cover,
              },
            ]}
          />
        </Pressable>
      </View>
      <View style={screen.inboxHero}>
        <Text style={[screen.inboxTitle, { color: palette.coverInk }]}>{t("inbox")}</Text>
        <View style={[screen.shiftPill, { backgroundColor: palette.cover }]}>
          <View
            style={[screen.shiftDot, { backgroundColor: me?.away ? palette.sub : palette.green }]}
          />
          <Text style={[screen.shiftText, { color: palette.coverSub }]}>
            <Text style={{ fontFamily: fonts.semibold, color: palette.coverInk }}>
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
    <Sheet
      onClose={onClose}
      palette={palette}
      title={t("mobileHarborFilterQueue")}
      visible={visible}
    >
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
          <Text style={[screen.sheetChoiceText, { color: palette.ink }]}>{scopeLabels[value]}</Text>
          {scope === value && <Icon name="check" size={20} color={palette.blue} />}
        </Pressable>
      ))}
    </Sheet>
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
  query,
  onClearSearch,
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
  query: string;
  onClearSearch(): void;
  session: Session;
  topInset: number;
  waiting: number;
  onAccount(): void;
  onRefresh(): Promise<void>;
  onOpen(conversation: Conversation): void;
  onOpenPending(conversationId: string): void;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [compact, setCompact] = useState(false);
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
  const longest = allWaiting[0] ? elapsedLabel(lastActivity(allWaiting[0])) : null;
  const pendingByConversation = pending.filter(
    (reply, index) =>
      pending.findIndex((other) => other.conversationId === reply.conversationId) === index,
  );
  const wanted = normalized(query);
  const searchResults = conversations.filter((conversation) => {
    if (!wanted || !isInScope(conversation, scope, meId)) return false;
    const copy = rowText(conversation);
    return normalized(
      `${visitorName(conversation)} ${conversation.visitor.email ?? ""} ${copy.subject} ${copy.preview ?? ""} ${conversation.lastMessage?.body ?? ""}`,
    ).includes(wanted);
  });
  const searching = query.trim().length > 0;
  const visibleCount = groupOrder.reduce((count, group) => count + groups[group].length, 0);

  async function pullToRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View
      style={{ flex: 1, backgroundColor: palette.paper }}
      onLayout={({ nativeEvent }) => setCompact(nativeEvent.layout.height < 320)}
    >
      {!compact && (
        <WorkspaceHeader
          longest={longest}
          me={me}
          onAccount={onAccount}
          palette={palette}
          session={session}
          topInset={topInset}
          waiting={waiting}
        />
      )}
      <ScopeTabs
        onFilter={() => setFilterOpen(true)}
        onScope={setScope}
        palette={palette}
        scope={scope}
      />
      <ScrollView
        style={{ flex: 1 }}
        alwaysBounceVertical
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={pullToRefresh}
            tintColor={palette.blue}
          />
        }
        contentContainerStyle={screen.inboxContent}
      >
        {!searching && pendingByConversation.length > 0 && (
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
        {loading && !refreshing && conversations.length === 0 ? (
          <ActivityIndicator color={palette.blue} style={screen.loading} />
        ) : searching ? (
          searchResults.length === 0 ? (
            <View style={screen.listEmpty}>
              <Image source={require("../assets/boat.png")} style={screen.emptyBoat} />
              <Text style={[screen.emptyTitle, { color: palette.ink }]}>
                {t("noMatchSearch", { query: query.trim() })}
              </Text>
              <Text style={[screen.emptyCopy, { color: palette.sub }]}>
                {t("noMatchSearchTry")}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onClearSearch}
                style={[screen.emptyAction, { borderColor: palette.line }]}
              >
                <Text style={[screen.emptyActionText, { color: palette.ink }]}>
                  {t("clearSearch")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={screen.searchResults}>
              <Text style={[screen.resultHeading, { color: palette.ink }]}>
                {t("mobileHarborConversations")}
              </Text>
              {searchResults.map((conversation) => (
                <ConversationRow
                  conversation={conversation}
                  key={conversation.id}
                  meId={meId}
                  onPress={() => onOpen(conversation)}
                  palette={palette}
                />
              ))}
            </View>
          )
        ) : visibleCount === 0 ? (
          <View style={screen.listEmpty}>
            <Image source={require("../assets/boat.png")} style={screen.emptyBoat} />
            <Text style={[screen.emptyTitle, { color: palette.ink }]}>{t("nothingOpen")}</Text>
            <Text style={[screen.emptyCopy, { color: palette.sub }]}>{t("nothingOpenHint")}</Text>
            {scope !== "all" && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setScope("all")}
                style={[screen.emptyAction, { borderColor: palette.line }]}
              >
                <Text style={[screen.emptyActionText, { color: palette.ink }]}>
                  {t("resetFilter")}
                </Text>
              </Pressable>
            )}
          </View>
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
    </View>
  );
}

function SettingsHeader({
  workspace,
  palette,
  topInset,
}: {
  workspace: string;
  palette: Palette;
  topInset: number;
}) {
  const dark = palette === night;
  return (
    <View style={[screen.settingsHeader, { backgroundColor: palette.analyticsSky }]}>
      <View pointerEvents="none" style={screen.settingsArt}>
        <Image
          accessible={false}
          source={
            dark ? require("../assets/settings-night.png") : require("../assets/settings-day.png")
          }
          style={screen.settingsImage}
        />
        <MovingPatch
          name="settings"
          source={
            dark
              ? require("../assets/settings-nod-night.png")
              : require("../assets/settings-nod-day.png")
          }
        />
      </View>
      <View style={[screen.settingsHeaderCopy, { paddingTop: topInset + 22 }]}>
        <Text
          accessibilityRole="header"
          style={[screen.secondaryTitle, { color: palette.coverInk }]}
        >
          {t("settings")}
        </Text>
        <Text style={[screen.secondaryDetail, { color: palette.coverSub }]}>{workspace}</Text>
      </View>
    </View>
  );
}

function PresenceChoice({
  active,
  activeBackground,
  activeTextColor,
  indicatorColor,
  label,
  palette,
  onPress,
}: {
  active: boolean;
  activeBackground: string;
  activeTextColor: string;
  indicatorColor: string;
  label: string;
  palette: Palette;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        screen.presenceChoice,
        {
          backgroundColor: active ? activeBackground : "transparent",
          opacity: pressed ? 0.72 : 1,
        },
      ]}
    >
      <View
        style={[
          screen.presenceChoiceDot,
          { backgroundColor: active ? indicatorColor : palette.sub },
        ]}
      />
      <Text style={[screen.presenceChoiceText, { color: active ? activeTextColor : palette.sub }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function NotificationPreference({
  detail,
  disabled,
  palette,
  status,
  onPress,
}: {
  detail: string;
  disabled: boolean;
  palette: Palette;
  status: PushStatus;
  onPress(): void;
}) {
  const healthy = status === "enabled";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        screen.preferenceRow,
        { borderColor: palette.line, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <View style={screen.preferenceIcon}>
        <Icon name="bell" size={21} color={palette.ink} />
      </View>
      <View style={screen.preferenceCopy}>
        <Text style={[screen.preferenceTitle, { color: palette.ink }]}>
          {t("mobilePushNotifications")}
        </Text>
        <View style={screen.preferenceStatusLine}>
          <View
            style={[
              screen.preferenceStatusDot,
              { backgroundColor: healthy ? palette.green : palette.amber },
            ]}
          />
          <Text style={[screen.preferenceDetail, { color: palette.sub }]}>{detail}</Text>
        </View>
      </View>
      {!disabled && <Icon name="next" size={18} color={palette.ink} />}
    </Pressable>
  );
}

function SettingsRow({
  detail,
  icon,
  palette,
  title,
  onPress,
}: {
  detail?: string;
  icon: "people" | "bookmark" | "settings";
  palette: Palette;
  title: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        screen.preferenceRow,
        { borderColor: palette.line, opacity: pressed ? 0.68 : 1 },
      ]}
    >
      <View style={screen.preferenceIcon}>
        <Icon name={icon} size={21} color={palette.ink} />
      </View>
      <View style={screen.preferenceCopy}>
        <Text style={[screen.preferenceTitle, { color: palette.ink }]}>{title}</Text>
        {detail !== undefined && (
          <Text style={[screen.preferenceDetail, { color: palette.sub }]}>{detail}</Text>
        )}
      </View>
      <Icon name="next" size={18} color={palette.sub} />
    </Pressable>
  );
}

const themeChoices: { value: ThemePreference; label: string }[] = [
  { value: "system", label: t("mobileThemeAutomatic") },
  { value: "light", label: t("themeLight") },
  { value: "dark", label: t("themeDark") },
];

function roleLabel(role: "owner" | "admin" | "member"): string {
  if (role === "owner") return t("roleOwner");
  if (role === "admin") return t("roleAdmin");
  return t("roleMember");
}

function ThemeChoice({
  palette,
  theme,
  onTheme,
}: {
  palette: Palette;
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
}) {
  return (
    <View style={screen.themeSection}>
      <Text
        accessibilityRole="header"
        style={[screen.settingsSectionTitle, { color: palette.sub }]}
      >
        {t("pageAppearance")}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("pageAppearance")}
        style={screen.themeControl}
      >
        {themeChoices.map(({ value, label }) => {
          const selected = value === theme;
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked: selected }}
              onPress={() => onTheme(value)}
              style={({ pressed }) => [
                screen.themeChoice,
                {
                  backgroundColor: palette.sheet,
                  borderColor: selected ? palette.blue : palette.line,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <View accessible={false} style={screen.themePreview}>
                {(value === "system" ? ["light", "dark"] : [value]).map((tone) => {
                  const light = tone === "light";
                  return (
                    <View
                      key={tone}
                      style={[
                        screen.previewPane,
                        { backgroundColor: light ? "#f1f0ec" : "#1c2937" },
                      ]}
                    >
                      <View
                        style={[
                          screen.previewHeading,
                          { backgroundColor: light ? "#586879" : "#bac8d8" },
                        ]}
                      />
                      <View
                        style={[
                          screen.previewLine,
                          { backgroundColor: light ? "#c2c7ce" : "#536479" },
                        ]}
                      />
                    </View>
                  );
                })}
              </View>
              <Text
                style={[screen.themeChoiceText, { color: selected ? palette.blue : palette.ink }]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function WorkspaceSheet({
  api,
  currentId,
  me,
  palette,
  visible,
  onClose,
  onRename,
  onWorkspace,
}: {
  api: DinghyApi;
  currentId: string;
  me: Me;
  palette: Palette;
  visible: boolean;
  onClose(): void;
  onRename(name: string): void;
  onWorkspace(workspaceId: string): void;
}) {
  const current = me.workspaces.find((workspace) => workspace.workspaceId === currentId);
  const [name, setName] = useState(current?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(current?.name ?? ""), [current?.name]);
  const save = async () => {
    const next = name.trim();
    if (!next || next === current?.name || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.renameWorkspace(next);
      onRename(result.name);
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet onClose={onClose} palette={palette} title={t("pageWorkspace")} visible={visible}>
      <ScrollView keyboardShouldPersistTaps="handled" style={screen.settingsSheetScroll}>
        {me.workspaces.map((workspace) => {
          const selected = workspace.workspaceId === currentId;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={workspace.workspaceId}
              onPress={() => {
                if (!selected) {
                  onClose();
                  onWorkspace(workspace.workspaceId);
                }
              }}
              style={[screen.workspaceChoice, { borderBottomColor: palette.line }]}
            >
              <Avatar
                kind="workspace"
                name={workspace.name}
                picture={workspace.logoUrl}
                size={38}
                palette={palette}
              />
              <View style={screen.workspaceChoiceCopy}>
                <Text style={[screen.sheetChoiceText, { color: palette.ink }]}>
                  {workspace.name}
                </Text>
                <Text style={[screen.preferenceDetail, { color: palette.sub }]}>
                  {roleLabel(workspace.role)}
                </Text>
              </View>
              {selected && <Icon name="check" size={20} color={palette.blue} />}
            </Pressable>
          );
        })}
        {current !== undefined &&
          current.role !== "member" &&
          current.active &&
          !current.readOnly &&
          !current.suspended && (
            <View style={screen.sheetForm}>
              <Text style={[screen.formLabel, { color: palette.ink }]}>
                {t("workspaceNameLabel")}
              </Text>
              <TextInput
                accessibilityLabel={t("workspaceNameLabel")}
                maxLength={100}
                onChangeText={setName}
                style={[
                  screen.formInput,
                  { color: palette.ink, borderColor: palette.line, backgroundColor: palette.wash },
                ]}
                value={name}
              />
              {error !== null && (
                <Text style={[screen.formError, { color: palette.amber }]}>{error}</Text>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={saving || !name.trim() || name.trim() === current.name}
                onPress={() => void save()}
                style={({ pressed }) => [
                  screen.formButton,
                  {
                    backgroundColor: palette.ink,
                    opacity:
                      saving || !name.trim() || name.trim() === current.name
                        ? 0.42
                        : pressed
                          ? 0.72
                          : 1,
                  },
                ]}
              >
                <Text style={[screen.formButtonText, { color: palette.paper }]}>
                  {saving ? t("loading") : t("save")}
                </Text>
              </Pressable>
            </View>
          )}
      </ScrollView>
    </Sheet>
  );
}

function TeamSheet({
  meId,
  members,
  palette,
  visible,
  onClose,
}: {
  meId: string;
  members: Member[];
  palette: Palette;
  visible: boolean;
  onClose(): void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 270;
  return (
    <Sheet
      onClose={onClose}
      palette={palette}
      title={t("mobileTeamTitle", { count: members.length })}
      visible={visible}
    >
      <ScrollView style={screen.teamList} contentContainerStyle={screen.teamListContent}>
        {members.map((member, index) => {
          const self = member.id === meId;
          const owner = member.role === "owner";
          const role = roleLabel(member.role);
          const roleBadge = (
            <Text
              style={[
                screen.teamRole,
                stacked && screen.teamBadgeStart,
                owner
                  ? { color: palette.blue, backgroundColor: palette.tint }
                  : { color: palette.sub, backgroundColor: palette.wash },
              ]}
            >
              {role}
            </Text>
          );
          return (
            <View key={member.id}>
              {index > 0 && (
                <View style={[screen.teamDivider, { backgroundColor: palette.line }]} />
              )}
              <View
                accessible
                accessibilityLabel={`${t("mobileTeamMember", {
                  name: self ? `${member.name}, ${t("you")}` : member.name,
                  role,
                })}, ${member.email}`}
                style={screen.teamRow}
              >
                <Avatar
                  name={member.name}
                  picture={member.pictureUrl}
                  size={42}
                  palette={palette}
                />
                <View style={screen.teamCopy}>
                  <View style={[screen.teamNameLine, stacked && screen.teamNameWrap]}>
                    <Text
                      numberOfLines={stacked ? undefined : 1}
                      style={[screen.teamName, { color: palette.ink }]}
                    >
                      {member.name}
                    </Text>
                    {self && (
                      <Text
                        style={[screen.teamYou, { color: palette.sub, borderColor: palette.line }]}
                      >
                        {t("you")}
                      </Text>
                    )}
                  </View>
                  <Text
                    numberOfLines={stacked ? undefined : 1}
                    style={[screen.teamEmail, { color: palette.sub }]}
                  >
                    {member.email}
                  </Text>
                  {stacked && roleBadge}
                </View>
                {!stacked && roleBadge}
              </View>
            </View>
          );
        })}
        <Text style={[screen.teamFootnote, { color: palette.sub }]}>{t("mobileTeamFootnote")}</Text>
      </ScrollView>
    </Sheet>
  );
}

function SavedRepliesSheet({
  api,
  canWrite,
  palette,
  visible,
  onClose,
}: {
  api: DinghyApi;
  canWrite: boolean;
  palette: Palette;
  visible: boolean;
  onClose(): void;
}) {
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setSelected(null);
    setShortcut("");
    setBody("");
    setError(null);
  };
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setReplies(null);
    void api.savedReplies().then(
      (result) => {
        if (active) setReplies(result.savedReplies);
      },
      (failure) => {
        if (active) setError(readableError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, visible]);
  const edit = (reply: SavedReply) => {
    setSelected(reply.id);
    setShortcut(reply.shortcut);
    setBody(reply.body);
    setError(null);
  };
  const save = async () => {
    const next = { shortcut: shortcut.trim(), body: body.trim() };
    if (!next.shortcut || !next.body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved =
        selected === null
          ? await api.addSavedReply(next)
          : await api.changeSavedReply(selected, next);
      setReplies((current) =>
        [...(current ?? []).filter((reply) => reply.id !== saved.id), saved].sort((left, right) =>
          left.shortcut.localeCompare(right.shortcut),
        ),
      );
      reset();
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      setBusy(false);
    }
  };
  const remove = (reply: SavedReply) => {
    Alert.alert(
      t("savedReplyDeleteTitle", { shortcut: reply.shortcut }),
      t("savedReplyDeleteText"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("delete"),
          style: "destructive",
          onPress: () => {
            setBusy(true);
            void api.deleteSavedReply(reply.id).then(
              () => {
                setReplies((current) => current?.filter((item) => item.id !== reply.id) ?? []);
                if (selected === reply.id) reset();
                setBusy(false);
              },
              (failure) => {
                setError(readableError(failure));
                setBusy(false);
              },
            );
          },
        },
      ],
    );
  };
  return (
    <Sheet onClose={onClose} palette={palette} title={t("pageSavedReplies")} visible={visible}>
      <ScrollView keyboardShouldPersistTaps="handled" style={screen.settingsSheetScroll}>
        {replies === null && error === null ? (
          <ActivityIndicator color={palette.blue} style={screen.sheetLoading} />
        ) : (
          replies?.map((reply) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canWrite }}
              disabled={!canWrite}
              key={reply.id}
              onPress={() => edit(reply)}
              style={[screen.replySettingRow, { borderBottomColor: palette.line }]}
            >
              <View style={screen.workspaceChoiceCopy}>
                <Text style={[screen.replyShortcut, { color: palette.ink }]}>
                  /{reply.shortcut}
                </Text>
                <Text numberOfLines={2} style={[screen.preferenceDetail, { color: palette.sub }]}>
                  {reply.body}
                </Text>
              </View>
              {canWrite && (
                <Pressable
                  accessibilityLabel={t("savedReplyDeleteLabel", { shortcut: reply.shortcut })}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={(event) => {
                    event.stopPropagation();
                    remove(reply);
                  }}
                  style={screen.deleteReply}
                >
                  <Icon name="x" size={17} color={palette.sub} />
                </Pressable>
              )}
            </Pressable>
          ))
        )}
        {replies?.length === 0 && (
          <Text style={[screen.emptySheetCopy, { color: palette.sub }]}>
            {t("savedRepliesNone")}
          </Text>
        )}
        {canWrite && (
          <View style={screen.sheetForm}>
            <Text style={[screen.formLabel, { color: palette.ink }]}>
              {selected === null ? t("savedReplyNew") : t("savedReplyEditLabel", { shortcut })}
            </Text>
            <TextInput
              accessibilityLabel={t("savedReplyShortcut")}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={32}
              onChangeText={setShortcut}
              placeholder={t("savedReplyShortcutPlaceholder")}
              placeholderTextColor={palette.sub}
              style={[
                screen.formInput,
                { color: palette.ink, borderColor: palette.line, backgroundColor: palette.wash },
              ]}
              value={shortcut}
            />
            <TextInput
              accessibilityLabel={t("savedReplyBody")}
              multiline
              onChangeText={setBody}
              placeholder={t("savedReplyBody")}
              placeholderTextColor={palette.sub}
              style={[
                screen.formInput,
                screen.replyBodyInput,
                { color: palette.ink, borderColor: palette.line, backgroundColor: palette.wash },
              ]}
              value={body}
            />
            {error !== null && (
              <Text style={[screen.formError, { color: palette.amber }]}>{error}</Text>
            )}
            <View style={screen.formActions}>
              {selected !== null && (
                <Pressable onPress={reset} style={screen.cancelButton}>
                  <Text style={[screen.cancelButtonText, { color: palette.ink }]}>
                    {t("cancel")}
                  </Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !shortcut.trim() || !body.trim()}
                onPress={() => void save()}
                style={({ pressed }) => [
                  screen.formButton,
                  {
                    backgroundColor: palette.ink,
                    opacity: busy || !shortcut.trim() || !body.trim() ? 0.42 : pressed ? 0.72 : 1,
                  },
                ]}
              >
                <Text style={[screen.formButtonText, { color: palette.paper }]}>
                  {busy ? t("loading") : t("save")}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}

export function SettingsScreen({
  api,
  me,
  members,
  palette,
  pushStatus,
  session,
  signingOut,
  theme,
  topInset,
  onAccountDeleted,
  onAway,
  onEnablePush,
  onSessionEnded,
  onSignOut,
  onProfileSaved,
  onTheme,
  onWorkspace,
  onWorkspaceRenamed,
}: {
  api: DinghyApi;
  me: Me | null;
  members: Member[];
  palette: Palette;
  pushStatus: PushStatus;
  session: Session;
  signingOut: boolean;
  theme: ThemePreference;
  topInset: number;
  onAccountDeleted(): void;
  onAway(): void;
  onEnablePush(): void;
  onSessionEnded(failure: ApiError): void;
  onSignOut(): void;
  onProfileSaved(me: Me): void;
  onTheme(theme: ThemePreference): void;
  onWorkspace(workspaceId: string): void;
  onWorkspaceRenamed(name: string): void;
}) {
  const dockInset = useTabBarInset();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [alerts, setAlerts] = useState<AlertSettings | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.alerts().then(
      (result) => {
        if (active) setAlerts(result);
      },
      (failure) => {
        if (active) setEmailError(readableError(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const pushCopy = {
    checking: t("mobilePushChecking"),
    enabled: t("mobilePushEnabled"),
    denied: t("mobilePushDenied"),
    unavailable: t("mobilePushUnavailable"),
    error: t("mobilePushError"),
  }[pushStatus];
  const away = me?.away ?? false;
  const name = me?.name ?? session.operator.name;
  const workspace = me?.workspaces.find((item) => item.workspaceId === session.workspace.id);
  const workspaceName = workspace?.name ?? session.workspace.name;
  const changeEmail = async (email: boolean) => {
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      setAlerts(await api.setAlerts(email));
    } catch (failure) {
      setEmailError(readableError(failure));
    } finally {
      setEmailBusy(false);
    }
  };
  return (
    <>
      <View
        pointerEvents="none"
        style={[screen.settingsOverscrollSky, { backgroundColor: palette.analyticsSky }]}
      />
      <ScrollView
        scrollIndicatorInsets={{ bottom: dockInset }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          backgroundColor: palette.paper,
          flexGrow: 1,
          paddingBottom: 16 + dockInset,
        }}
      >
        <SettingsHeader workspace={workspaceName} palette={palette} topInset={topInset} />
        <View
          style={[
            screen.profilePanel,
            { backgroundColor: palette.sheet, borderColor: palette.line },
          ]}
        >
          <Pressable
            accessibilityLabel={t("pageProfile")}
            accessibilityRole="button"
            disabled={me === null}
            onPress={() => setProfileOpen(true)}
            style={({ pressed }) => [screen.profileIdentity, pressed && { opacity: 0.7 }]}
          >
            <View style={screen.profileAvatar}>
              <Avatar name={name} picture={me?.pictureUrl ?? null} size={52} palette={palette} />
              <View
                style={[
                  screen.profileStatusDot,
                  {
                    backgroundColor: away ? palette.amber : palette.green,
                    borderColor: palette.sheet,
                  },
                ]}
              />
            </View>
            <View style={screen.profileCopy}>
              <Text style={[screen.profileName, { color: palette.ink }]}>{name}</Text>
              <Text style={[screen.profileEmail, { color: palette.sub }]}>{me?.email ?? ""}</Text>
            </View>
            {me !== null && (
              <View style={screen.editProfile}>
                <Text style={[screen.themeChoiceText, { color: palette.blue }]}>{t("edit")}</Text>
                <Icon name="next" size={14} color={palette.blue} />
              </View>
            )}
          </Pressable>
          <View
            accessibilityLabel={t("mobileHarborAvailability")}
            accessibilityRole="radiogroup"
            style={[screen.presenceControl, { backgroundColor: palette.wash }]}
          >
            <PresenceChoice
              active={!away}
              activeBackground="#bcebd2"
              activeTextColor="#12382c"
              indicatorColor="#167052"
              label={t("statusAvailable")}
              onPress={() => away && onAway()}
              palette={palette}
            />
            <PresenceChoice
              active={away}
              activeBackground={palette.line}
              activeTextColor={palette.ink}
              indicatorColor={palette.amber}
              label={t("statusAway")}
              onPress={() => !away && onAway()}
              palette={palette}
            />
          </View>
        </View>
        <ThemeChoice onTheme={onTheme} palette={palette} theme={theme} />
        <View style={screen.preferencesSection}>
          <Text style={[screen.settingsSectionTitle, { color: palette.sub }]}>
            {t("pageNotifications")}
          </Text>
          <NotificationPreference
            detail={pushCopy}
            disabled={pushStatus === "checking" || pushStatus === "unavailable"}
            onPress={onEnablePush}
            palette={palette}
            status={pushStatus}
          />
          {alerts?.emailAvailable === true && (
            <View style={[screen.preferenceRow, { borderColor: palette.line }]}>
              <View style={screen.preferenceIcon}>
                <Icon name="mail" size={21} color={palette.ink} />
              </View>
              <View style={screen.preferenceCopy}>
                <Text style={[screen.preferenceTitle, { color: palette.ink }]}>
                  {t("emailAlerts")}
                </Text>
                <Text style={[screen.preferenceDetail, { color: palette.sub }]}>
                  {t("emailAlertsHelp")}
                </Text>
              </View>
              <Switch
                accessibilityLabel={t("emailAlerts")}
                disabled={emailBusy}
                onValueChange={(value) => void changeEmail(value)}
                ios_backgroundColor={palette.switchOff}
                trackColor={{ false: palette.switchOff, true: palette.green }}
                value={alerts.email}
              />
            </View>
          )}
          {emailError !== null && (
            <Text style={[screen.formError, { color: palette.amber }]}>{emailError}</Text>
          )}
        </View>
        {me !== null && (
          <View style={screen.preferencesSection}>
            <Text style={[screen.settingsSectionTitle, { color: palette.sub }]}>
              {t("settingsGroupWorkspace")}
            </Text>
            <SettingsRow
              detail={workspaceName}
              icon="settings"
              onPress={() => setWorkspaceOpen(true)}
              palette={palette}
              title={t("pageWorkspace")}
            />
            <SettingsRow
              detail={t("mobileSettingsMemberCount", { count: members.length })}
              icon="people"
              onPress={() => setTeamOpen(true)}
              palette={palette}
              title={t("pageTeam")}
            />
            <SettingsRow
              icon="bookmark"
              onPress={() => setRepliesOpen(true)}
              palette={palette}
              title={t("pageSavedReplies")}
            />
            {workspace !== undefined && workspace.role !== "member" && (
              <AdminTools
                api={api}
                canWrite={workspace.active && !workspace.readOnly && !workspace.suspended}
                session={session}
                palette={palette}
              />
            )}
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: signingOut }}
          disabled={signingOut}
          onPress={onSignOut}
          style={({ pressed }) => [screen.signOutAction, { opacity: pressed ? 0.65 : 1 }]}
        >
          <Icon name="arrow" size={18} color={palette.sub} />
          <View style={screen.signOutCopy}>
            <Text style={[screen.signOutTitle, { color: palette.ink }]}>
              {signingOut ? t("mobileSigningOut") : t("signOut")}
            </Text>
          </View>
        </Pressable>
        {/* Small and far below Sign out, so nobody presses it by mistake. */}
        {me !== null && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: signingOut }}
            disabled={signingOut}
            onPress={() => setDeleteOpen(true)}
            style={({ pressed }) => [screen.deleteAccountAction, { opacity: pressed ? 0.65 : 1 }]}
          >
            <Text style={[screen.deleteAccountTitle, { color: palette.danger }]}>
              {t("deleteAccountOpen")}
            </Text>
          </Pressable>
        )}
      </ScrollView>
      {me !== null && (
        <>
          <WorkspaceSheet
            api={api}
            currentId={session.workspace.id}
            me={me}
            onClose={() => setWorkspaceOpen(false)}
            onRename={onWorkspaceRenamed}
            onWorkspace={onWorkspace}
            palette={palette}
            visible={workspaceOpen}
          />
          <TeamSheet
            meId={me.id}
            members={members}
            onClose={() => setTeamOpen(false)}
            palette={palette}
            visible={teamOpen}
          />
          <SavedRepliesSheet
            api={api}
            canWrite={workspace?.active === true && !workspace.readOnly && !workspace.suspended}
            onClose={() => setRepliesOpen(false)}
            palette={palette}
            visible={repliesOpen}
          />
          <DeleteAccountSheet
            api={api}
            me={me}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => {
              setDeleteOpen(false);
              onAccountDeleted();
            }}
            onSessionEnded={(failure) => {
              setDeleteOpen(false);
              onSessionEnded(failure);
            }}
            palette={palette}
            visible={deleteOpen}
          />
          <ProfileSheet
            api={api}
            me={me}
            onClose={() => setProfileOpen(false)}
            onSaved={onProfileSaved}
            palette={palette}
            visible={profileOpen}
          />
        </>
      )}
    </>
  );
}
