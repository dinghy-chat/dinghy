/** Something that Dinghy Cloud tells its admins about, after the change commits. */
export type CloudNotice =
  | { kind: "widget_installed"; workspaceId: string; origin: string }
  | { kind: "operator_joined"; workspaceId: string; operatorId: string };

/** Hands a notice to the cloud. It returns at once and never throws. */
export type NoticeCloud = (notice: CloudNotice) => void;
