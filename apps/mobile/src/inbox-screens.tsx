import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { t } from "../../operator/src/text.ts";
import type { PendingReply } from "../outbox";
import { Avatar, initials, visitorName } from "./common";
import type { PushStatus } from "./notifications";
import { type Palette, styles } from "./theme";
import type { Conversation, Me, Session } from "./types";

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

function ConversationRow({
  conversation,
  palette,
  onPress,
}: {
  conversation: Conversation;
  palette: Palette;
  onPress(): void;
}) {
  const name = visitorName(conversation);
  const handler = conversation.handler;
  const owner =
    handler?.kind === "person"
      ? handler.name
      : handler?.kind === "bot"
        ? t("mobileHandlerBot", { name: handler.name })
        : t("handlerTeam");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.wash }]}
    >
      <Avatar name={name} picture={conversation.visitor.pictureUrl} palette={palette} />
      <View style={[styles.rowBody, { borderBottomColor: palette.line }]}>
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={[styles.rowName, { color: palette.ink }]}>
            {name}
          </Text>
          <Text style={[styles.wait, { color: palette.amber }]}>
            {waitLabel(conversation.updatedAt)}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.snippet, { color: palette.ink }]}>
          {conversation.lastMessage?.body || t("mobileAttachment")}
        </Text>
        <View style={styles.rowTop}>
          <Text style={[styles.rowMeta, { color: palette.sub }]}>{owner}</Text>
          {conversation.unread && (
            <View style={[styles.unread, { backgroundColor: palette.blue }]} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

export function InboxScreen({
  conversations,
  loading,
  me,
  palette,
  pending,
  session,
  waiting,
  onRefresh,
  onOpen,
  onOpenPending,
}: {
  conversations: Conversation[];
  loading: boolean;
  me: Me | null;
  palette: Palette;
  pending: PendingReply[];
  session: Session;
  waiting: number;
  onRefresh(): void;
  onOpen(conversation: Conversation): void;
  onOpenPending(conversationId: string): void;
}) {
  const pendingByConversation = pending.filter(
    (reply, index) =>
      pending.findIndex((other) => other.conversationId === reply.conversationId) === index,
  );
  const ordered = conversations.slice().sort((left, right) => {
    const leftWaits = left.lastMessage?.fromVisitor === true && left.snooze === null;
    const rightWaits = right.lastMessage?.fromVisitor === true && right.snooze === null;
    if (leftWaits !== rightWaits) return leftWaits ? -1 : 1;
    return leftWaits
      ? Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  return (
    <FlatList
      data={ordered}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={palette.blue} />
      }
      contentContainerStyle={[styles.listContent, ordered.length === 0 && styles.listEmpty]}
      ListHeaderComponent={
        <View>
          <View style={styles.accountBar}>
            <View style={styles.workspacePill}>
              <Image
                source={require("../assets/boat.png")}
                style={styles.workspaceBoat}
                resizeMode="contain"
              />
              <Text numberOfLines={1} style={[styles.workspaceName, { color: palette.ink }]}>
                {session.workspace.name}
              </Text>
            </View>
            <View style={[styles.meAvatar, { backgroundColor: palette.warm }]}>
              <Text style={[styles.meAvatarText, { color: palette.amber }]}>
                {initials(session.operator.name)}
              </Text>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: me?.away ? palette.sub : palette.green,
                    borderColor: palette.paper,
                  },
                ]}
              />
            </View>
          </View>
          <View style={styles.hero}>
            <Text style={[styles.heroTitle, { color: palette.ink }]}>{t("inbox")}</Text>
            <View style={styles.shiftLine}>
              <View
                style={[
                  styles.shiftDot,
                  { backgroundColor: me?.away ? palette.sub : palette.green },
                ]}
              />
              <Text style={[styles.shiftText, { color: palette.sub }]}>
                <Text style={{ color: palette.ink, fontWeight: "700" }}>
                  {me?.away ? t("statusAway") : t("statusAvailable")}
                </Text>
                {waiting ? t("mobileQueueNeedsReply", { count: waiting }) : t("mobileQueueClear")}
              </Text>
            </View>
          </View>
          {pendingByConversation.length > 0 && (
            <View style={styles.savedReplies}>
              <Text style={[styles.savedRepliesTitle, { color: palette.sub }]}>
                {t("pageSavedReplies")}
              </Text>
              {pendingByConversation.map((reply) => {
                const count = pending.filter(
                  (other) => other.conversationId === reply.conversationId,
                ).length;
                const conversation = conversations.find((item) => item.id === reply.conversationId);
                return (
                  <Pressable
                    key={reply.conversationId}
                    onPress={() => onOpenPending(reply.conversationId)}
                    style={({ pressed }) => [
                      styles.savedReplyRow,
                      {
                        backgroundColor: palette.wash,
                        borderColor: palette.line,
                        opacity: pressed ? 0.75 : 1,
                      },
                    ]}
                  >
                    <Text style={{ color: palette.amber }}>◷</Text>
                    <View style={styles.savedReplyCopy}>
                      <Text
                        numberOfLines={1}
                        style={[styles.savedReplyName, { color: palette.ink }]}
                      >
                        {conversation
                          ? visitorName(conversation)
                          : t("mobileSavedReplyConversation")}
                        {count > 1 ? t("mobileSavedReplyCount", { count }) : ""}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[styles.savedReplyBody, { color: palette.sub }]}
                      >
                        {reply.body}
                      </Text>
                    </View>
                    <Text style={{ color: palette.blue }}>›</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          <View
            style={[
              styles.sectionHead,
              { borderColor: palette.line, backgroundColor: palette.paper },
            ]}
          >
            <View style={styles.sectionTitleLine}>
              <Text style={[styles.sectionTitle, { color: palette.ink }]}>
                {t("mobileOpenConversations")}
              </Text>
              <Text style={[styles.count, { backgroundColor: palette.warm, color: palette.amber }]}>
                {waiting}
              </Text>
            </View>
            <Text style={[styles.oldest, { color: palette.sub }]}>
              {t("mobileNeedsReplyFirst")}
            </Text>
          </View>
        </View>
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator color={palette.blue} />
        ) : (
          <View style={styles.emptyState}>
            <Image
              source={require("../assets/boat.png")}
              style={styles.emptyBoat}
              resizeMode="contain"
            />
            <Text style={[styles.emptyTitle, { color: palette.ink }]}>
              {t("mobileNoOpenConversations")}
            </Text>
            <Text style={[styles.emptyCopy, { color: palette.sub }]}>{t("mobileNewMessages")}</Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <ConversationRow conversation={item} onPress={() => onOpen(item)} palette={palette} />
      )}
    />
  );
}

export function SearchScreen({
  conversations,
  palette,
  onOpen,
}: {
  conversations: Conversation[];
  palette: Palette;
  onOpen(conversation: Conversation): void;
}) {
  const [query, setQuery] = useState("");
  const shown = conversations.filter((conversation) =>
    `${visitorName(conversation)} ${conversation.lastMessage?.body ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <View style={styles.pagePad}>
      <Text style={[styles.heroTitle, { color: palette.ink }]}>{t("searchPlaceholder")}</Text>
      <TextInput
        autoCapitalize="none"
        onChangeText={setQuery}
        placeholder={t("mobileSearchInput")}
        placeholderTextColor={palette.sub}
        style={[
          styles.searchInput,
          { backgroundColor: palette.wash, color: palette.ink, borderColor: palette.line },
        ]}
        value={query}
      />
      {query.trim() === "" ? (
        <Text style={[styles.searchHint, { color: palette.sub }]}>{t("mobileSearchHint")}</Text>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ConversationRow conversation={item} palette={palette} onPress={() => onOpen(item)} />
          )}
        />
      )}
    </View>
  );
}

export function SettingsScreen({
  me,
  palette,
  pushStatus,
  signingOut,
  onAway,
  onEnablePush,
  onSignOut,
}: {
  me: Me | null;
  palette: Palette;
  pushStatus: PushStatus;
  signingOut: boolean;
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
  return (
    <View style={styles.pagePad}>
      <Text style={[styles.heroTitle, { color: palette.ink }]}>{t("mobileShiftSettings")}</Text>
      <Text style={[styles.settingsSub, { color: palette.sub }]}>{t("mobileSettingsCopy")}</Text>
      <Pressable
        onPress={onAway}
        style={[styles.settingCard, { backgroundColor: palette.wash, borderColor: palette.line }]}
      >
        <Avatar
          name={me?.name ?? t("mobileOperator")}
          picture={me?.pictureUrl ?? null}
          palette={palette}
        />
        <View style={styles.settingCopy}>
          <Text style={[styles.settingTitle, { color: palette.ink }]}>
            {me?.name ?? t("mobileOperator")}
          </Text>
          <Text style={[styles.settingDetail, { color: palette.sub }]}>
            {me?.away ? t("mobileAwayDetail") : t("mobileAvailableDetail")}
          </Text>
        </View>
        <View style={[styles.availability, { backgroundColor: palette.tint }]}>
          <Text style={[styles.availabilityText, { color: palette.blue }]}>
            {me?.away ? t("statusAway") : t("statusAvailable")}
          </Text>
        </View>
      </Pressable>
      <View style={[styles.settingsBlock, { borderColor: palette.line }]}>
        <Pressable
          disabled={pushStatus === "checking" || pushStatus === "unavailable"}
          onPress={onEnablePush}
          style={[styles.settingsRow, { borderBottomColor: palette.line }]}
        >
          <Text style={[styles.settingTitle, { color: palette.ink }]}>
            {t("mobilePushNotifications")}
          </Text>
          <Text style={[styles.settingDetail, { color: palette.sub }]}>{pushCopy}</Text>
        </Pressable>
        <Pressable disabled={signingOut} onPress={onSignOut} style={styles.settingsRow}>
          <Text style={[styles.settingTitle, { color: "#b73a36" }]}>
            {signingOut ? t("mobileSigningOut") : t("signOut")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
