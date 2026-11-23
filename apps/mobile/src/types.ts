export type Session = {
  origin: string;
  session: string;
  operator: { id: string; name: string };
  workspace: { id: string; name: string };
};

export type Workspace = {
  workspaceId: string;
  role: "owner" | "admin" | "member";
  name: string;
  logoUrl: string | null;
  active: boolean;
  readOnly: boolean;
  suspended: boolean;
  /** This operator is the workspace's only owner. */
  soleOwner: boolean;
  /** For an only owner: who becomes the owner when they delete their account. Null when nobody. */
  heir: string | null;
};

export type Quote = {
  id: string | null;
  authorName: string | null;
  fromVisitor: boolean;
  text: string;
  hasImage: boolean;
};

export type ReplyReceipts = {
  readSeq: string;
  emails: { fromSeq: string; toSeq: string; sent: boolean }[];
  notEmailed: string[];
};

export type Me = {
  id: string;
  name: string;
  email: string;
  pictureUrl: string | null;
  away: boolean;
  workspaces: Workspace[];
  /** How the account's delete is confirmed: by a link sent to it, or at once by typing its email. */
  deleteConfirmation: "email" | "typed";
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
  authorApiKeyId: string | null;
  authorName: string | null;
  clientId: string;
  body: string | null;
  attachment: MessageAttachment;
  replyTo: Quote | null;
  editedAt: string | null;
  readAt: string | null;
  mentions: string[];
  createdAt: string;
  deleted: boolean;
  via: "api" | "mcp" | "draft" | "email" | null;
  fromAddress?: string | null;
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
  receipts: ReplyReceipts;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  pictureUrl: string | null;
};

export type SavedReply = {
  id: string;
  shortcut: string;
  body: string;
  updatedAt: string;
};

export type LabelColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "purple";

export type Label = { id: string; name: string; color: LabelColor };

export type PushProvider = "apns" | "fcm";

export type AlertSettings = {
  email: boolean;
  emailAvailable: boolean;
  pushKey: string | null;
  nativePushProviders?: PushProvider[];
};

export type NotificationRoute = {
  workspaceId?: string;
  conversationId?: string;
  url?: string;
};
