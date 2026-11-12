import { useEffect, useState } from "preact/hooks";
import type { Client } from "./client.ts";

const PRESENCE_EVERY_MS = 30_000;

/**
 * Whether the team is online, who is, and whether this server sends reply emails, asked again every
 * 30 seconds while `asking`. Only an open panel asks, so a page view costs the server nothing more.
 * `token` goes only on the chat page, where it is what lets the request in.
 */
export function usePresence(client: Client, token: string | null, asking: boolean) {
  // Null means unknown, and then the panel says nothing about the team.
  const [online, setOnline] = useState<boolean | null>(null);
  // The members online now, by the hash on their faces.
  const [members, setMembers] = useState<string[]>([]);
  // False until the server says, so the form never promises an email that this server cannot send.
  const [emailReplies, setEmailReplies] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const ask = () => {
      client.presence(token).then(
        (state) => {
          setOnline(state.online);
          setMembers(state.members);
          setEmailReplies(state.emailReplies);
        },
        () => setOnline(null),
      );
    };
    ask();
    const timer = setInterval(ask, PRESENCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [asking, client, token]);
  return { online, members, emailReplies };
}
