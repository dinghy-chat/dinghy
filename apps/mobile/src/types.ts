export type Session = {
  origin: string;
  session: string;
  operator: { id: string; name: string };
  workspace: { id: string; name: string };
};

type Workspace = {
  workspaceId: string;
  name: string;
  active: boolean;
  readOnly: boolean;
  suspended: boolean;
};

export type Me = {
  id: string;
  name: string;
  email: string;
  pictureUrl: string | null;
  away: boolean;
  workspaces: Workspace[];
};

type Handler =
  | { kind: "bot"; apiKeyId: string; name: string }
  | { kind: "person"; operatorId: string; name: string; since: string }
  | { kind: "team"; since: string }
  | null;

export type Conversation = {
  id: string;
  status: "open" | "closed";
  updatedAt: string;
  subject?: string | null;
  hasReadyDraft?: boolean;
  assigneeOperatorId: string | null;
  bot?: { apiKeyId: string; name: string } | null;
  visitor: {
    attributes?: Record<string, unknown> | null;
    id: string;
    name: string | null;
    email: string | null;
    pictureUrl: string | null;
  };
  lastMessage: {
    body: string | null;
    kind: "text" | "image" | "file";
    fromVisitor: boolean;
    createdAt: string;
  } | null;
  handler: Handler;
  unread: boolean;
  snooze: { until: string | null } | null;
};

export type Message = {
  id: string;
  conversationId: string;
  seq: string;
  kind: "text" | "image" | "file" | "closed" | "reopened" | "note";
  fromVisitor: boolean;
  authorOperatorId: string | null;
  authorName: string | null;
  clientId: string;
  body: string | null;
  attachment: MessageAttachment;
  createdAt: string;
  deleted: boolean;
};

export type MessageAttachment =
  | { type: "image"; url: string; width: number; height: number; removed?: never }
  | { type: "file"; url: string; name: string; size: number; removed?: never }
  | { type: "image" | "file"; removed: true }
  | null;

export type PhotoUpload = {
  uri: string;
  mimeType: string;
};

export type Thread = {
  conversation: Conversation;
  messages: Message[];
  hasMore: boolean;
  visitorOnline: boolean | null;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  pictureUrl: string | null;
};

export type SavedReply = {
  id: string;
  shortcut: string;
  body: string;
  updatedAt: string;
};

export type PushProvider = "apns" | "fcm";

export type AlertSettings = {
  email: boolean;
  nativePushProviders: PushProvider[];
};

export type NotificationRoute = {
  workspaceId?: string;
  conversationId?: string;
  url?: string;
};
