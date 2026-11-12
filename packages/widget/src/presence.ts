import { useEffect, useState } from "preact/hooks";
import type { Client, Presence } from "./client.ts";

const PRESENCE_EVERY_MS = 30_000;

/**
 * Whether the team is online, who is, whether this server sends reply emails, and the header's
 * usual reply time, asked again every 30 seconds while `asking`. Only an open panel asks, so a page
 * view costs the server nothing more. `token` goes only on the chat page, where it is what lets the
 * request in.
 */
export function usePresence(client: Client, token: string | null, asking: boolean): Presence {
  // emailReplies is false until the server says, so the form never promises an email that this
  // server cannot send.
  const [state, setState] = useState<Presence>({
    online: null,
    members: [],
    emailReplies: false,
    replySeconds: null,
  });
  useEffect(() => {
    if (!asking) return;
    const ask = () => {
      client
        .presence(token)
        .then(setState, () => setState((current) => ({ ...current, online: null })));
    };
    ask();
    const timer = setInterval(ask, PRESENCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [asking, client, token]);
  return state;
}
