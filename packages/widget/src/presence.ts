import { useEffect, useState } from "preact/hooks";
import type { Client, Texts } from "./client.ts";

const PRESENCE_EVERY_MS = 30_000;

const NO_TEXTS: Texts = { title: null, greeting: null, away: null };

/**
 * Whether the team is online, whether this server sends reply emails, and the workspace's own
 * words and logo, asked again every 30 seconds while `asking`. Only an open panel asks, so a page
 * view costs the server nothing. `token` goes only on the chat page, where it is what lets the request in.
 */
export function usePresence(client: Client, token: string | null, asking: boolean) {
  // Null means unknown, and then the panel says nothing about the team.
  const [online, setOnline] = useState<boolean | null>(null);
  // False until the server says, so the form never promises an email that this server cannot send.
  const [emailReplies, setEmailReplies] = useState(false);
  // Null until the first answer, so the default title never shows before the workspace's own.
  const [texts, setTexts] = useState<Texts | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asking) return;
    const ask = () => {
      client.presence(token).then(
        (state) => {
          setOnline(state.online);
          setEmailReplies(state.emailReplies);
          setTexts(state.texts);
          setLogoUrl(state.logoUrl);
        },
        () => {
          setOnline(null);
          setTexts((current) => current ?? NO_TEXTS);
        },
      );
    };
    ask();
    const timer = setInterval(ask, PRESENCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [asking, client, token]);
  return { online, emailReplies, texts, logoUrl };
}
