// The words of the emails a visitor gets, in each language the widget speaks. A visitor gets them
// in the widget's language from their last visit. Each language has every key, and English is the
// one for a visitor from before languages.

import type { Locale } from "../../../packages/widget/src/shared.ts";
import { CHAT_LINK_DAYS } from "./chat-link.ts";

/** A date and time in UTC, so a transcript reads the same anywhere. */
const utcTime = (locale: Locale) => {
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  return (at: Date) => `${format.format(at)} UTC`;
};

const en = {
  // What comes before a colon, as French puts a space there.
  lead: (text: string) => `${text}:`,
  hi: "Hi,",
  signOff: (team: string) => `Cheers,\nThe ${team} team`,
  you: "You",
  // A team reply whose author's account or key is gone.
  team: (name: string) => `The ${name} team`,
  quoteDeleted: "Original message deleted",
  quoteImage: "An image",
  anImage: "Sent an image.",
  aFile: (name: string | null) => (name === null ? "Sent a file." : `Sent the file ${name}.`),
  linkWarning: `The link works for ${CHAT_LINK_DAYS} days. Anyone who has it can read and reply, so don't forward this email.`,
  gotThisBecause: (name: string) =>
    `You got this because this address was entered in a chat with ${name}.`,
  stopHere: (stop: string) =>
    `If that wasn't you, or you'd rather not get these emails, stop them here: ${stop}`,
  stopThem: "Stop these emails",
  replySubject: (name: string) => `${name} replied to your message`,
  repliedTo: (name: string) => `${name} replied to your message:`,
  replied: (who: string) => `${who} replied`,
  answerHere: (chat: string) => `Read the conversation and answer here: ${chat}`,
  replyInChat: "Reply in the chat",
  transcriptSubject: (name: string) => `Your conversation with ${name}`,
  transcriptIntro: (name: string) => `Here is your conversation with ${name}, for your records.`,
  transcriptImage: "Sent an image. Open the chat to see it.",
  transcriptFile: (name: string | null) =>
    `Sent ${name === null ? "a file" : `the file ${name}`}. Open the chat to download it.`,
  continueChat: "Continue the chat",
  // The first line of an email that takes replies. A reply is cut where its quote of this line starts.
  replyAbove: "Write your reply above this line",
  attachmentsLeftOut: (count: number, max: number) =>
    `${count === 1 ? "1 attachment was" : `${count} attachments were`} left out. The chat takes up to ${max} per email, of the types and sizes it allows.`,
  time: utcTime("en"),
};

export type VisitorWords = typeof en;

// French puts a no-break space before a colon, so the colon never starts a line.
const FR_COLON = "\u00a0:";

const fr: VisitorWords = {
  lead: (text) => `${text}${FR_COLON}`,
  hi: "Bonjour,",
  signOff: (team) => `À bientôt,\nL'équipe ${team}`,
  you: "Vous",
  team: (name) => `L'équipe ${name}`,
  quoteDeleted: "Message d'origine supprimé",
  quoteImage: "Une image",
  anImage: "A envoyé une image.",
  aFile: (name) => (name === null ? "A envoyé un fichier." : `A envoyé le fichier ${name}.`),
  linkWarning: `Le lien fonctionne pendant ${CHAT_LINK_DAYS} jours. Toute personne qui a ce lien peut lire la conversation et y répondre, alors ne transférez pas cet e-mail.`,
  gotThisBecause: (name) =>
    `Vous recevez cet e-mail car cette adresse a été saisie dans un chat avec ${name}.`,
  stopHere: (stop) =>
    `Si ce n'était pas vous, ou si vous ne souhaitez plus recevoir ces e-mails, désinscrivez-vous ici${FR_COLON} ${stop}`,
  stopThem: "Ne plus recevoir ces e-mails",
  replySubject: (name) => `${name} a répondu à votre message`,
  repliedTo: (name) => `${name} a répondu à votre message${FR_COLON}`,
  replied: (who) => `${who} a répondu`,
  answerHere: (chat) => `Lisez la conversation et répondez ici${FR_COLON} ${chat}`,
  replyInChat: "Répondre dans le chat",
  transcriptSubject: (name) => `Votre conversation avec ${name}`,
  transcriptIntro: (name) => `Voici votre conversation avec ${name}, pour vos archives.`,
  transcriptImage: "Image envoyée. Ouvrez le chat pour la voir.",
  transcriptFile: (name) =>
    `${name === null ? "Fichier envoyé" : `Fichier ${name} envoyé`}. Ouvrez le chat pour le télécharger.`,
  continueChat: "Continuer la conversation",
  replyAbove: "Écrivez votre réponse au-dessus de cette ligne",
  attachmentsLeftOut: (count, max) =>
    `${count === 1 ? "1 pièce jointe n'a pas été ajoutée" : `${count} pièces jointes n'ont pas été ajoutées`}. Le chat accepte jusqu'à ${max} pièces jointes par e-mail, aux formats et aux tailles qu'il autorise.`,
  time: utcTime("fr"),
};

const es: VisitorWords = {
  lead: (text) => `${text}:`,
  hi: "Hola:",
  signOff: (team) => `Un saludo,\nEl equipo de ${team}`,
  you: "Tú",
  team: (name) => `El equipo de ${name}`,
  quoteDeleted: "Mensaje original eliminado",
  quoteImage: "Una imagen",
  anImage: "Envió una imagen.",
  aFile: (name) => (name === null ? "Envió un archivo." : `Envió el archivo ${name}.`),
  linkWarning: `El enlace funciona durante ${CHAT_LINK_DAYS} días. Cualquiera que lo tenga puede leer y responder, así que no reenvíes este correo.`,
  gotThisBecause: (name) =>
    `Recibes este correo porque esta dirección se escribió en un chat con ${name}.`,
  stopHere: (stop) =>
    `Si no fuiste tú, o prefieres no recibir estos correos, puedes darte de baja aquí: ${stop}`,
  stopThem: "Dejar de recibir estos correos",
  replySubject: (name) => `${name} respondió a tu mensaje`,
  repliedTo: (name) => `${name} respondió a tu mensaje:`,
  replied: (who) => `${who} respondió`,
  answerHere: (chat) => `Lee la conversación y responde aquí: ${chat}`,
  replyInChat: "Responder en el chat",
  transcriptSubject: (name) => `Tu conversación con ${name}`,
  transcriptIntro: (name) => `Esta es tu conversación con ${name}, para que la guardes.`,
  transcriptImage: "Se envió una imagen. Abre el chat para verla.",
  transcriptFile: (name) =>
    `Se envió ${name === null ? "un archivo" : `el archivo ${name}`}. Abre el chat para descargarlo.`,
  continueChat: "Continuar la conversación",
  replyAbove: "Escribe tu respuesta encima de esta línea",
  attachmentsLeftOut: (count, max) =>
    `${count === 1 ? "No se añadió 1 archivo adjunto" : `No se añadieron ${count} archivos adjuntos`}. El chat acepta hasta ${max} por correo, de los tipos y tamaños que permite.`,
  time: utcTime("es"),
};

const WORDS: Record<Locale, VisitorWords> = { en, fr, es };

/** The marker line in every language, since a visitor's language may change between two emails. */
export const REPLY_MARKERS = Object.values(WORDS).map((words) => words.replyAbove);

/** The words for a visitor whose widget spoke this language, or English when it is not known. */
export const visitorWords = (locale: Locale | null): VisitorWords => WORDS[locale ?? "en"];
