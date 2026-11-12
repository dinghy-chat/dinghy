import { reducedMotion, sleeperFor } from "./motion.js";

const VISIBLE_SHARE = 0.15;
const POP_FRAMES = [{ opacity: 0, transform: "translateY(10px) scale(.86)" }, {}];
const POP_TIMING = { duration: 400, easing: "cubic-bezier(.2,1.5,.4,1)" };

const INBOX_CHATS = [
  { name: "Jon Reyes", text: "Can I book a Friday class?", by: "Priya" },
  { name: "Visitor 4821", text: "Hello? Is someone there?", by: "Tom" },
  { name: "Maya Chen", text: "Do you deliver on Sundays?", by: "Ana" },
  { name: "Leo Martin", text: "Where is my order #4102?", by: "Tom" },
];
const PICTURES = { Ana: "/img/people/ana.webp", Tom: "/img/people/tom.webp", Priya: "/img/people/priya.webp" };

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

/** A chat arrives unread and waiting, then a teammate takes it and starts typing. */
async function inbox(toy, sleep) {
  const list = toy.querySelector(".chat-list");
  const sample = list.firstElementChild.cloneNode(true);
  const name = toy.querySelector(".app-conversation-name");
  const head = toy.querySelector(".app-conversation-head .avatar");
  const text = toy.querySelector(".app-conversation-text");
  const status = toy.querySelector(".app-conversation-status");
  const typing = list.querySelector(".typing").cloneNode(true);
  const typingFor = (who) => {
    const line = typing.cloneNode(true);
    line.lastChild.textContent = `${who} is replying`;
    return line;
  };
  const picture = (who) => {
    const image = document.createElement("img");
    image.className = "handler";
    image.src = PICTURES[who];
    image.width = image.height = 20;
    image.alt = "";
    return image;
  };

  for (let turn = 0; ; turn++) {
    await sleep(2600);
    const chat = INBOX_CHATS[turn % INBOX_CHATS.length];
    const row = sample.cloneNode(true);
    setAvatar(row.querySelector(".avatar"), chat.name);
    row.querySelector("b").textContent = chat.name;
    row.querySelector("small").textContent = chat.text;
    for (const open of list.querySelectorAll(".is-open")) open.classList.remove("is-open");
    row.classList.add("is-new");
    list.prepend(row);
    keepFirst(list, 4);
    name.textContent = chat.name;
    setAvatar(head, chat.name);
    text.textContent = chat.text;
    status.replaceChildren();
    toy.querySelector(".app-badge").textContent = toy.querySelector(".app-waiting").textContent = "3";

    await sleep(1600);
    row.classList.remove("is-new", "is-unread");
    row.querySelector(".unread-dot")?.remove();
    row.querySelector(".chat-row-meta").replaceChildren(typingFor(chat.by), picture(chat.by));
    status.replaceChildren(typingFor(chat.by));
    toy.querySelector(".app-badge").textContent = toy.querySelector(".app-waiting").textContent = "2";
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

const AGENT_CHATS = [
  {
    name: "Emma Holt",
    question: "Can I switch to the yearly plan?",
    answer: "Yes! Open Billing and pick Yearly.",
    sender: "Ana",
  },
  { name: "Jon Reyes", question: "I was charged twice. Can I get a refund?" },
  {
    name: "Sara Okafor",
    question: "Does the import take CSV files?",
    answer: "It does. Drop it in Import.",
    sender: "Tom",
  },
];

/** The bot drafts a reply and a person sends it, or the bot hands the chat to the team. */
async function agent(toy, sleep) {
  const log = toy.querySelector(".agent-log");
  const handler = toy.querySelector(".agent-handler-name");
  const set = (selector, text) => {
    for (const node of toy.querySelectorAll(selector)) node.textContent = text;
  };

  for (let turn = 0; ; turn++) {
    const chat = AGENT_CHATS[turn % AGENT_CHATS.length];
    log.dataset.state = "";
    set(".agent-name", chat.name);
    setAvatar(toy.querySelector(".agent-thread .avatar"), chat.name);
    set(".agent-question", chat.question);
    handler.textContent = "Support bot";
    handler.parentElement.classList.remove("is-team");
    toy.querySelector(".agent-question").animate(POP_FRAMES, POP_TIMING);
    await sleep(1300);
    if (!chat.answer) {
      log.dataset.state = "handoff";
      handler.textContent = "Team";
      handler.parentElement.classList.add("is-team");
      await sleep(3800);
      continue;
    }
    set(".agent-answer", chat.answer);
    log.dataset.state = "draft";
    await sleep(2400);
    log.classList.add("is-pressing");
    await sleep(220);
    log.classList.remove("is-pressing");
    set(".agent-sent-by", `Sent by ${chat.sender}`);
    toy.querySelector(".agent-label-sent img").src = PICTURES[chat.sender];
    log.dataset.state = "sent";
    await sleep(2200);
  }
}

const LIVE_VISITORS = [
  { flag: "FR", name: "Visitor 9KD2", page: "/menu, from Instagram" },
  { flag: "GB", name: "Emma Holt", page: "/account/billing", chatting: true },
  { flag: "BR", name: "Visitor 5TQ1", page: "/, from Google" },
  { flag: "CA", name: "Jon Reyes", page: "/classes/friday" },
  { flag: "IN", name: "Visitor 3MZ8", page: "/pricing", chatting: true },
  { flag: "JP", name: "Visitor 2QX9", page: "/blog/sourdough, from Hacker News" },
  { flag: "AU", name: "Visitor 8HW4", page: "/blog/rye-bread" },
  { flag: "US", name: "Leo Martin", page: "/orders/4102" },
];

async function visitors(toy, sleep) {
  const list = toy.querySelector(".live-list");
  const count = toy.querySelector(".live-count");
  const pins = [...toy.querySelectorAll(".live-pin")];
  const [chatting, browsing] = [...list.children].map((row) => row.cloneNode(true));
  for (let turn = 0; ; turn++) {
    await sleep(2200);
    const visitor = LIVE_VISITORS[turn % LIVE_VISITORS.length];
    const row = (visitor.chatting ? chatting : browsing).cloneNode(true);
    row.querySelector(".live-flag").textContent = visitor.flag;
    row.querySelector("b").textContent = visitor.name;
    row.querySelector("small").textContent = visitor.page;
    row.classList.add("is-new");
    list.prepend(row);
    keepFirst(list, 2);
    for (const pin of pins) pin.classList.toggle("is-on", pin.classList.contains(`pin-${visitor.flag.toLowerCase()}`));
    count.textContent = String(11 + (turn % 4));
    await sleep(1200);
    row.classList.remove("is-new");
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

const TOYS = { inbox, alerts, colors, agent, visitors, control, install };

export function startToys() {
  if (reducedMotion) return;
  for (const toy of document.querySelectorAll("[data-toy]")) {
    TOYS[toy.dataset.toy](toy, sleeperFor(toy, VISIBLE_SHARE));
  }
}
