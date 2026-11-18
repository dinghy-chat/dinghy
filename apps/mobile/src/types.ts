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
  assigneeOperatorId: string | null;
  visitor: {
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
  createdAt: string;
  deleted: boolean;
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
