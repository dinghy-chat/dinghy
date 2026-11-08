import { reducedMotion, sleeperFor } from "./motion.js";

const VISIBLE_SHARE = 0.15;
const POP_FRAMES = [{ opacity: 0, transform: "translateY(10px) scale(.86)" }, {}];
const POP_TIMING = { duration: 400, easing: "cubic-bezier(.2,1.5,.4,1)" };

const INBOX_CHATS = [
  { name: "Jon Reyes", text: "Can I book a Friday class?", kind: "unassigned" },
  { name: "Emma Holt", text: "Do you send receipts?", kind: "assigned", who: "Priya Nair" },
  { name: "Visitor 4821", text: "Hello? Is someone there?", kind: "unassigned" },
  { name: "Maya Chen", text: "Do you deliver on Sundays?", kind: "unassigned" },
  { name: "Leo Martin", text: "Where is my order #4102?", kind: "replying", who: "Tom" },
  { name: "Sara Okafor", text: "My import keeps failing. Help?", kind: "assigned", who: "Ana Ruiz" },
];
const TEAM = ["Ana", "Tom", "Priya"];

const ALERTS = [
  { name: "Sara Okafor", text: "My import keeps failing. Help?", kind: "email" },
  { name: "Emma Holt", text: "Do you send receipts?", kind: "push" },
  { name: "Maya Chen", text: "Do you deliver on Sundays?", kind: "email" },
  { name: "Leo Martin", text: "Where is my order #4102?", kind: "push" },
];

const initials = (name) =>
  name.startsWith("Visitor") ? "V" : name.split(" ").map((word) => word[0]).join("");
const tintClass = (name) => `tint-${name.startsWith("Visitor") ? 4 : name.length % 4}`;

function setAvatar(avatar, name) {
  avatar.textContent = initials(name);
  avatar.className = avatar.className.replace(/tint-\d/, tintClass(name));
}

function keepFirst(parent, count) {
  while (parent.children.length > count) parent.lastElementChild.remove();
}

async function inbox(toy, sleep) {
  const list = toy.querySelector(".chat-list");
  const [unassigned, replying, assigned] = [...list.children].map((row) => row.cloneNode(true));
  const samples = { unassigned, replying, assigned };
  const conversationName = toy.querySelector(".app-conversation-name");
  const conversationText = toy.querySelector(".app-conversation-text");
  const conversationStatus = toy.querySelector(".app-conversation-status");
  const replyingLine = (who) => {
    const meta = replying.querySelector(".chat-row-meta").cloneNode(true);
    meta.querySelector(".who").textContent = `${who} is replying`;
    return meta;
  };

  for (let turn = 0; ; turn++) {
    await sleep(2300);
    const chat = INBOX_CHATS[turn % INBOX_CHATS.length];
    const row = samples[chat.kind].cloneNode(true);
    setAvatar(row.querySelector(".avatar"), chat.name);
    row.querySelector("b").textContent = chat.name;
    row.querySelector("small").textContent = chat.text;
    const who = row.querySelector(".who");
    if (who) who.textContent = chat.kind === "replying" ? `${chat.who} is replying` : chat.who;
    const metaAvatar = row.querySelector(".chat-row-meta .avatar");
    if (metaAvatar) setAvatar(metaAvatar, chat.who);
    row.classList.add("is-new");
    list.prepend(row);
    keepFirst(list, 3);
    conversationName.textContent = chat.name;
    conversationText.textContent = chat.text;
    conversationStatus.replaceChildren();

    await sleep(1400);
    row.classList.remove("is-new");
    if (chat.kind !== "unassigned") continue;
    const operator = TEAM[turn % TEAM.length];
    row.querySelector(".chat-row-meta").replaceWith(replyingLine(operator));
    conversationStatus.replaceChildren(replyingLine(operator));
  }
}

async function alerts(toy, sleep) {
  const phone = toy.querySelector(".phone");
  const [email, push] = [...phone.children].map((alert) => alert.cloneNode(true));
  const samples = { email, push };
  for (let turn = 0; ; turn++) {
    await sleep(2000);
    const alert = ALERTS[turn % ALERTS.length];
    const notice = samples[alert.kind].cloneNode(true);
    notice.querySelector(".notice-name").textContent = alert.name;
    notice.querySelector("small").textContent = alert.text;
    phone.prepend(notice);
    keepFirst(phone, 3);
  }
}

/** The radios work with CSS alone. This only steps through them until the visitor picks one. */
async function colors(toy, sleep) {
  const radios = [...toy.querySelectorAll("input")];
  let picked = false;
  toy.addEventListener("change", () => {
    picked = true;
  });
  for (let i = 1; ; i++) {
    await sleep(1700);
    if (picked) return;
    radios[i % radios.length].checked = true;
  }
}

async function images(toy, sleep) {
  const upload = toy.querySelector(".upload");
  const shot = toy.querySelector(".upload-shot");
  const reply = document.createElement("div");
  reply.className = "chat-bubble from-visitor pop";
  reply.textContent = "Thanks, I can see the cause.";
  for (;;) {
    shot.classList.add("is-waiting");
    await sleep(500);
    shot.classList.remove("is-waiting");
    shot.animate(POP_FRAMES, POP_TIMING);
    await sleep(1550);
    upload.append(reply);
    await sleep(2200);
    reply.remove();
  }
}

async function control(toy, sleep) {
  const rows = [...toy.children];
  for (let i = 0; ; i++) {
    rows.forEach((row, k) => row.classList.toggle("is-on", k === i % rows.length));
    await sleep(1600);
  }
}

/** Retypes the tag that the page already shows, one character at a time. */
async function install(toy, sleep) {
  const line = toy.querySelector(".editor-typed");
  const button = toy.querySelector(".install-launcher");
  const status = toy.querySelector(".editor-status");
  const parts = [...line.children].map((part) => ({
    className: part.className,
    text: part.textContent,
  }));
  const length = parts.reduce((sum, part) => sum + part.text.length, 0);

  const typed = (count) => {
    let left = count;
    const pieces = [];
    for (const { className, text } of parts) {
      if (left <= 0) break;
      const piece = document.createElement("i");
      piece.className = className;
      piece.textContent = text.slice(0, left);
      pieces.push(piece);
      left -= text.length;
    }
    return pieces;
  };
  const caret = document.createElement("i");
  caret.className = "caret";

  for (;;) {
    button.classList.add("is-off");
    line.replaceChildren();
    status.textContent = "Editing";
    status.classList.add("is-editing");
    await sleep(700);
    for (let count = 1; count <= length; count++) {
      line.replaceChildren(...typed(count), caret);
      await sleep(24);
    }
    line.replaceChildren(...typed(length));
    await sleep(350);
    status.textContent = "Saved";
    status.classList.remove("is-editing");
    await sleep(450);
    button.classList.remove("is-off");
    await sleep(4600);
  }
}

const TOYS = { inbox, alerts, colors, images, control, install };

export function startToys() {
  if (reducedMotion) return;
  for (const toy of document.querySelectorAll("[data-toy]")) {
    TOYS[toy.dataset.toy](toy, sleeperFor(toy, VISIBLE_SHARE));
  }
}
