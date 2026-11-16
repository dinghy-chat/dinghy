// Outbound messages: what the team sent this visitor outside any conversation. They wait as a badge,
// a card above the launcher or the open chat, until the visitor answers, dismisses or leaves them.
// All of this is in the chat bundle, so the loader only learns from its beat that one waits.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Answer, Client, Waiting } from "./client.ts";
import { emit } from "./page-events.ts";
import { ChatLine, CloseButton, type Line } from "./panel.tsx";
import {
  chosenButton,
  OUTBOUND_ANSWERED_MAX,
  type OutboundButton,
  type ReceivedMessage,
  type WidgetContext,
} from "./shared.ts";
import { language, t } from "./text.ts";

/** The open panel fills a screen this narrow, so a message shows as a card there instead. */
const PHONE = "(max-width:480px)";

/** A waiting message as a line of the chat. Its ID cannot be a message's. */
export const waitingLine = (one: Waiting): Line => ({
  id: `outbound:${one.id}`,
  seq: null,
  body: one.body,
  attachment: null,
  fromVisitor: false,
  author:
    one.authorId === null || one.authorName === null
      ? null
      : {
          id: one.authorId,
          name: one.authorName,
          pictureUrl: one.authorPictureUrl,
          bot: one.fromBot,
        },
  status: "sent",
});

/** A message whose buttons the visitor can choose: one that waits, or one in the conversation. */
export type Choosable = Pick<Waiting, "id" | "buttons"> & { campaignId?: string | null };

/** A page campaign's card, which has no ID of its own until the visitor answers: its campaign's. */
const isPage = (one: Choosable) => one.id === one.campaignId;

/** The IDs the page events carry: a card's is null. */
const idsOf = (one: Choosable) => ({
  id: isPage(one) ? null : one.id,
  campaignId: one.campaignId ?? null,
});

const received = (one: Waiting): ReceivedMessage => ({
  id: null,
  body: one.body,
  sender: { name: one.authorName, pictureUrl: one.authorPictureUrl },
  outbound: { ...idsOf(one), show: one.show, buttons: one.buttons },
});

/** Whether a field of the host page has focus, which a message must not take. */
function pageTyping(host: Element): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === host) return false;
  return active.isContentEditable || active.matches("input,textarea,select");
}

const adding = (ids: string[]) => (current: ReadonlySet<string>) => new Set([...current, ...ids]);

const without =
  (id: string) =>
  <T extends { id: string }>(list: T[]) =>
    list.filter((one) => one.id !== id);

interface Options {
  open: boolean;
  /** The visitor can see the open chat now. */
  seeing: boolean;
  /** Opens the chat without taking the page's focus. */
  reveal(): void;
  /** Grows with each beat that says a message waits. */
  beat: number;
}

/**
 * The waiting messages, fetched when the chat loads, on each open, and when the beat or the stream
 * says one waits. The visitor reads one when it shows in the open chat. A `chat` message opens the
 * chat, unless that would cover a phone's screen, come back after the visitor closed it on this
 * page, or take the focus of a field the visitor types in: then it shows as a card.
 */
export function useOutbound(
  context: WidgetContext,
  client: Client,
  token: string | null,
  { open, seeing, reveal, beat }: Options,
) {
  const [fetched, setWaiting] = useState<Waiting[]>([]);
  const [pages, setPages] = useState<Waiting[]>([]);
  const askedPages = useRef(new Set<string>());
  const waiting = useMemo(() => [...fetched, ...pages], [fetched, pages]);
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(0);
  const announced = useRef(new Set<string>());
  const opened = useRef(new Set<string>());
  const closedHere = useRef(false);
  const wasOpen = useRef(open);

  const markRead = (ids: string[]) => setRead(adding(ids));

  /** The page campaigns whose time came on this page, each asked for once. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `beat` says the loader added one.
  useEffect(() => {
    for (const id of context.pages ?? []) {
      if (askedPages.current.has(id)) continue;
      askedPages.current.add(id);
      client.showPage(token, id, language()).then(
        (one) => {
          emit(context, "message:received", received(one));
          setPages((current) => [...current, one]);
        },
        () => {
          // It may no longer show to this visitor. The next page load tries again.
        },
      );
    }
  }, [beat, client, context, token]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked`, `beat` and `open` ask for a fetch.
  useEffect(() => {
    if (token === null) return;
    let stale = false;
    client.waiting(token).then(
      (list) => {
        if (stale) return;
        for (const one of list.filter((each) => !announced.current.has(each.id))) {
          announced.current.add(one.id);
          emit(context, "message:received", received(one));
        }
        setRead(adding(list.filter((one) => one.read).map((one) => one.id)));
        setWaiting(list);
      },
      () => {
        // The next beat or open asks again.
      },
    );
    return () => {
      stale = true;
    };
  }, [asked, beat, client, context, open, token]);

  useEffect(() => {
    if (wasOpen.current && !open) closedHere.current = true;
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    // A page card needs no visitor. A waiting message is theirs only.
    const unseen = waiting.filter((one) => !read.has(one.id) && (token !== null || isPage(one)));
    if (!seeing || unseen.length === 0) return;
    setRead(adding(unseen.map((one) => one.id)));
    for (const one of unseen) {
      const reading =
        token === null || isPage(one)
          ? client.countPage(token, one.id, language())
          : client.readOutbound(token, one.id);
      reading.then(
        () => emit(context, "outbound:read", { ...idsOf(one), button: null }),
        () => {
          // It counts as read here. The next answer names it, and the server checks it then.
        },
      );
    }
  }, [client, context, read, seeing, token, waiting]);

  const unread = waiting.filter((one) => !read.has(one.id));
  // Only a message that waits pulses the launcher. The loader stops it at the next open.
  useEffect(() => {
    if (!open && unread.length > 0) context.nudge(true);
  }, [context, open, unread.length]);

  const mayOpen = () =>
    !closedHere.current && !matchMedia(PHONE).matches && !pageTyping(context.shadow.host);
  const opening = open
    ? undefined
    : unread.find((one) => one.show === "chat" && !opened.current.has(one.id));
  // biome-ignore lint/correctness/useExhaustiveDependencies: mayOpen reads the page at this moment.
  useEffect(() => {
    if (opening === undefined || !mayOpen()) return;
    opened.current.add(opening.id);
    reveal();
  }, [opening, reveal]);

  /** A chosen button reads the message, and the page hears of the read the first time. */
  const readBy = (one: Choosable, button: OutboundButton) => {
    if (read.has(one.id)) return;
    markRead([one.id]);
    emit(context, "outbound:read", { ...idsOf(one), button: chosenButton(button) });
  };

  /** A button that opens a page or dismisses. A value button answers, which the chat sends. */
  const press = (one: Choosable, index: number) => {
    const button = one.buttons[index];
    if (button === undefined || (token === null && !isPage(one))) return;
    if (button.url !== undefined) window.open(button.url, "_blank", "noopener");
    readBy(one, button);
    const pressing =
      token === null || isPage(one)
        ? client.countPage(token, one.id, language(), index)
        : client.press(token, one.id, button.dismiss ? "dismiss" : "click", index);
    pressing.then(
      () => {
        if (!button.dismiss) return;
        setWaiting(without(one.id));
        setPages(without(one.id));
        setHidden(adding([one.id]));
        emit(context, "outbound:dismissed", { ...idsOf(one), button: chosenButton(button) });
      },
      () => {
        // The click is only recorded. A dismiss stays on screen, so the visitor can try again.
      },
    );
  };

  return {
    waiting,
    unread: unread.length,
    /** The newest message that asks for a card, unless the visitor closed its card. */
    card: open
      ? undefined
      : unread.filter((one) => one.show !== "badge" && !hidden.has(one.id)).at(-1),
    hide: (id: string) => setHidden(adding([id])),
    /** Whether the page heard of this message when it showed. */
    announced: (id: string) => announced.current.has(id),
    ask: () => setAsked((current) => current + 1),
    press,
    readBy,
    /** Whether the visitor closed this message's card or dismissed it in this tab. */
    isHidden: (id: string) => hidden.has(id),
    /**
     * What the visitor's next message answers: every message they read here, in order, and the
     * newest page card they read, with the button they chose on it.
     */
    answer: (button?: Answer["button"]): Answer => {
      const isRead = (one: Waiting) => read.has(one.id);
      // A button reads its card too, in a state that may not show here yet.
      const card =
        pages.find((one) => one.id === button?.outboundMessageId) ?? pages.filter(isRead).at(-1);
      const onCard = card !== undefined && button?.outboundMessageId === card.id;
      return {
        outboundIds: fetched
          .filter(isRead)
          .map((one) => one.id)
          .slice(-OUTBOUND_ANSWERED_MAX),
        ...(button !== undefined && !onCard && { button }),
        ...(card !== undefined && {
          pageCampaign: {
            id: card.id,
            language: language(),
            ...(onCard && { button: button.index }),
          },
        }),
      };
    },
    /** These went in the conversation, which shows them from now. */
    answered: ({ outboundIds, pageCampaign }: Answer) => {
      const gone = (one: Waiting) => outboundIds.includes(one.id) || one.id === pageCampaign?.id;
      setWaiting((current) => current.filter((one) => !gone(one)));
      setPages((current) => current.filter((one) => !gone(one)));
    },
  };
}

/** A message's buttons. */
export function Choices({ one, onPress }: { one: Choosable; onPress(index: number): void }) {
  if (one.buttons.length === 0) return null;
  return (
    <div class="choices">
      {one.buttons.map((button, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a message's buttons never move, and two may share a label.
        <button type="button" key={index} onClick={() => onPress(index)}>
          {button.label}
        </button>
      ))}
    </div>
  );
}

const noop = () => {};

/** The card above the launcher: who sent it, its first lines, and its buttons. A click opens the chat. */
export function PreviewCard({
  one,
  onOpen,
  onClose,
  onPress,
}: {
  one: Waiting;
  onOpen(): void;
  onClose(): void;
  onPress(index: number): void;
}) {
  return (
    <aside class="preview" aria-live="polite" aria-label={t("outboundCard")}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the launcher opens the chat from the keyboard. */}
      <div class="peek" onClick={onOpen}>
        <ChatLine
          line={waitingLine(one)}
          showAuthor
          onView={onOpen}
          onUploadError={noop}
          onRetry={noop}
        />
      </div>
      <Choices one={one} onPress={onPress} />
      <CloseButton label={t("outboundClose")} onClick={onClose} />
    </aside>
  );
}
