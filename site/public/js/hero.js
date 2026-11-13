import { Boat } from "./boat.js";
import { animateWhileVisible, onWidthChange, reducedMotion, sleeperFor } from "./motion.js";
import { CREAM, FAR, MIDDLE, NEAR, STILL_MOMENT, Water } from "./water.js";

const LAYERS = [
  { level: 0.34, swell: 3, ...FAR },
  { level: 0.55, swell: 4, ...MIDDLE },
  { level: 0.8, swell: 4.5, ...NEAR },
];
const LIFT_BY_LAYER = [0.6, 0.85, 1];
const CHAT_LAYER = 1;
const SMALL_WIDTH = 700;
const CHAT_SECONDS = 3.6;

const CHATS = [
  ["Do you deliver on Sundays?", "Yes, before noon. Want a slot?", "Tom"],
  ["Where is my order #4102?", "It ships today. Tracking is coming.", "Ana"],
  ["Can I change my plan?", "Yes. I can switch it for you now.", "Priya"],
  ["Do you have this in a medium?", "We do. Two are left in stock.", "Tom"],
  ["Can I get a refund?", "Of course. I just sent it.", "Ana"],
  ["Is anyone there?", "Yes, hi! How can I help?", "Priya"],
  ["My import keeps failing. Help?", "Found the cause. Try it now.", "Tom"],
  ["Can I book a table for Friday?", "Yes, 7 pm is free. Shall I book it?", "Ana"],
].map(([question, answer, operator]) => ({ question, answer, operator }));

const chatAt = (index) => CHATS[index % CHATS.length];

/** A row of springs along the water, pushed by the cursor and the boat. */
class Ripples {
  static SPACING = 10;
  static FIXED_STEP = 1 / 60;

  reset(width) {
    this.count = Math.ceil(width / Ripples.SPACING) + 2;
    this.heights = new Float32Array(this.count);
    this.speeds = new Float32Array(this.count);
    this.pending = 0;
  }

  heightAt(x) {
    const i = Math.max(0, Math.min(this.count - 1, Math.trunc(x / Ripples.SPACING)));
    return this.heights[i];
  }

  push(x, force) {
    const i = Math.trunc(x / Ripples.SPACING);
    if (i > 0 && i < this.count - 1) this.speeds[i] += force;
  }

  advance(step) {
    this.pending += step;
    while (this.pending >= Ripples.FIXED_STEP) {
      this.pending -= Ripples.FIXED_STEP;
      this.settle();
    }
  }

  settle() {
    const { heights, speeds, count } = this;
    for (let i = 0; i < count; i++) speeds[i] = (speeds[i] - 0.02 * heights[i]) * 0.965;
    for (let i = 1; i < count - 1; i++) {
      speeds[i] += 0.1 * (heights[i - 1] + heights[i + 1] - 2 * heights[i]);
    }
    for (let i = 0; i < count; i++) heights[i] = Math.max(-9, Math.min(9, heights[i] + speeds[i]));
  }
}

/** The chat bubble above the boat. It stays upright while the boat rocks. */
class Bubble {
  constructor(boat) {
    this.boat = boat;
    this.element = document.createElement("span");
    this.element.className = "bubble";
    boat.element.append(this.element);
  }

  show(content, fromTeam) {
    const line = document.createElement("i");
    line.className = "bubble-line";
    line.append(...content);
    this.element.classList.toggle("is-team", fromTeam);
    this.element.replaceChildren(line);
    this.center();
  }

  center() {
    const offset = this.boat.size / 2 - this.element.offsetWidth / 2;
    this.element.style.transform = `translateX(${offset.toFixed(1)}px)`;
  }
}

function typingDots() {
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.innerHTML = "<i></i><i></i><i></i>";
  return dots;
}

export function drawSunPath(water, sunX, t) {
  const { back } = water;
  back.fillStyle = CREAM;
  for (let i = 0; i < 7; i++) {
    const y = water.surfaceY(sunX, 0, t) + 7 + i * 5.5;
    if (y >= water.height) continue;
    const width = (46 - i * 3) * (0.65 + 0.35 * Math.sin(t * 1.8 + i * 1.7));
    back.globalAlpha = 0.75 - i * 0.08;
    back.beginPath();
    back.roundRect(sunX - width / 2 + Math.sin(t + i) * 8, y, width, 2.5, 2);
    back.fill();
  }
  back.globalAlpha = 1;
}

function drawWake(water, boat, strength, t) {
  const { back } = water;
  const behind = -boat.direction;
  back.strokeStyle = "#fff";
  back.lineCap = "round";
  for (let i = 1; i <= 5; i++) {
    const x = boat.x + behind * (boat.size * 0.42 + i * i * 2.6);
    const y = water.surfaceY(x, CHAT_LAYER, t) + 3 + i * 0.7;
    back.globalAlpha = (0.75 - i * 0.12) * strength;
    back.lineWidth = 2.5 - i * 0.25;
    back.beginPath();
    back.moveTo(x, y);
    back.lineTo(x + behind * (7 + i * 2), y + 1);
    back.stroke();
  }
  back.globalAlpha = 1;
}

/** Drops of spray from the bow. */
class Spray {
  drops = [];

  throw(x, y, direction) {
    this.drops.push({
      x,
      y,
      speedX: direction * (0.5 + Math.random()),
      speedY: -(1.2 + Math.random() * 1.3),
      life: 1,
    });
  }

  draw(context, step) {
    const frames = step * 60;
    context.fillStyle = "#fff";
    for (const drop of this.drops) {
      drop.x += drop.speedX * frames;
      drop.y += drop.speedY * frames;
      drop.speedY += 0.09 * frames;
      drop.life -= 0.035 * frames;
      context.globalAlpha = Math.max(0, drop.life);
      context.beginPath();
      context.arc(drop.x, drop.y, 1.8, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    this.drops = this.drops.filter((drop) => drop.life > 0);
  }
}

export function drawShoreline(water, t) {
  const { front, width, height } = water;
  front.fillStyle = "#fff";
  front.beginPath();
  front.moveTo(-8, height);
  for (let x = -8; x <= width + 8; x += 8) {
    front.lineTo(x, height - 9 + 2.4 * Math.sin(x * 0.018 + t * 0.45));
  }
  front.lineTo(width + 8, height);
  front.closePath();
  front.fill();
}

function followPointer(hero, host, ripples) {
  let lastX = null;
  hero.addEventListener(
    "pointermove",
    (event) => {
      const { top, bottom } = host.getBoundingClientRect();
      if (event.clientY < top - 20 || event.clientY > bottom) {
        lastX = null;
        return;
      }
      if (lastX !== null) {
        const force = Math.min(30, Math.abs(event.clientX - lastX)) * 0.035;
        for (let k = -2; k <= 2; k++) {
          ripples.push(event.clientX + k * Ripples.SPACING, force * (1 - Math.abs(k) * 0.3));
        }
      }
      lastX = event.clientX;
    },
    { passive: true },
  );
}

/** The boat sails over with the visitor's questions, turns, and brings the answers back. */
class Voyage {
  constructor(water, sleep, spray, ripples, boat) {
    Object.assign(this, { water, sleep, spray, ripples, boat });
    this.bubble = new Bubble(boat);
    this.clock = 0;
    this.move = null;
    this.rotation = null;
    boat.direction = 1;
    boat.x = -300;
  }

  get small() {
    return this.water.width < SMALL_WIDTH;
  }

  /** Shows one side of the chats, moving on to the next one until the leg ends. */
  speak(side, index) {
    const fromTeam = side === "answer";
    this.bubble.show([chatAt(index)[side]], fromTeam);
    this.rotation = { side, index, fromTeam, nextAt: this.clock + CHAT_SECONDS };
  }

  sail(to) {
    const speed = this.small ? 45 : 80;
    const seconds = Math.abs(to - this.boat.x) / speed;
    return new Promise((arrive) => {
      this.move = { from: this.boat.x, to, startedAt: this.clock, seconds, arrive };
    });
  }

  async run() {
    let first = 0;
    // The first trip starts in view, so the boat is there when the page opens.
    let inView = true;
    for (;;) {
      this.boat.setSize(this.small ? 104 : 138);
      const offscreen = this.boat.size / 2 + (this.small ? 120 : 170);
      this.boat.turn(1, false);
      this.speak("question", first);
      const start = Math.max(this.water.width * 0.12, this.bubble.element.offsetWidth / 2 + 16);
      this.boat.x = inView ? start : -offscreen;
      inView = false;
      await this.sail(this.water.width + offscreen);
      const last = this.rotation.index;
      this.rotation = null;
      await this.sleep(350);

      this.boat.turn(-1, true);
      const { operator } = chatAt(first);
      this.bubble.show([`${operator} is replying`, typingDots()], true);
      await this.sail(this.water.width - this.boat.size * 0.7);
      await this.sleep(1400);
      this.speak("answer", first);
      await this.sail(-offscreen);
      this.rotation = null;
      first = last + 1;
      await this.sleep(350);
    }
  }

  advance(step, t) {
    this.clock += step;
    const { boat, rotation, move } = this;
    if (rotation && this.clock >= rotation.nextAt) {
      rotation.index += 1;
      rotation.nextAt = this.clock + CHAT_SECONDS;
      this.bubble.show([chatAt(rotation.index)[rotation.side]], rotation.fromTeam);
    }
    if (!move) return;
    const progress = Math.min(1, (this.clock - move.startedAt) / move.seconds);
    const eased = 0.85 * progress + 0.15 * progress * progress * (3 - 2 * progress);
    boat.x = move.from + (move.to - move.from) * eased;
    const strength = progress * (1 - progress) * 4;
    if (strength > 0.15) this.churn(strength, t, step);
    if (progress === 1) {
      this.move = null;
      move.arrive();
    }
  }

  churn(strength, t, step) {
    const { boat, water } = this;
    drawWake(water, boat, strength, t);
    if (Math.random() < 0.22 * strength) {
      const bow = boat.x + boat.direction * boat.size * 0.46;
      this.spray.throw(bow, water.surfaceY(boat.x, CHAT_LAYER, t) - 1, boat.direction);
    }
    this.ripples.push(boat.x, 3 * strength * step);
  }
}

export function startHero() {
  const host = document.querySelector("[data-hero-water]");
  const hero = document.querySelector("[data-hero]");
  const sun = host.querySelector(".sun");
  const ripples = new Ripples();
  const water = new Water(host, {
    layers: LAYERS,
    lift: (x, index) => ripples.heightAt(x) * LIFT_BY_LAYER[index],
  });
  ripples.reset(water.width);
  const boats = host.querySelector("[data-boats]");
  const small = () => water.width < SMALL_WIDTH;
  const farSize = () => (small() ? 44 : 62);
  const farBoat = new Boat(boats, farSize(), { main: CREAM, jib: CREAM });
  const chatBoat = new Boat(boats, small() ? 104 : 138);
  let sunX = 0;
  let farX = water.width * 0.3;

  const measure = () => {
    const { left, width } = sun.getBoundingClientRect();
    sunX = left + width / 2;
    farBoat.setSize(farSize());
  };

  const spray = new Spray();
  const voyage = reducedMotion ? null : new Voyage(water, sleeperFor(host), spray, ripples, chatBoat);

  const draw = (t, step) => {
    water.clear();
    water.driftWavelets(step);
    water.drawLayer(water.back, 0, t);
    drawSunPath(water, sunX, t);
    water.drawLayer(water.back, 1, t);
    farX += (small() ? 0.1 : 0.16) * step * 60;
    if (farX > water.width + 60) farX = -60;
    water.float(farBoat, farX, 0, t);
    water.float(chatBoat, chatBoat.x, CHAT_LAYER, t);
    voyage?.advance(step, t);
    spray.draw(water.back, step);
    water.drawLayer(water.front, 2, t);
    drawShoreline(water, t);
    ripples.advance(step);
  };

  const drawStill = () => {
    chatBoat.x = water.width / 2;
    draw(STILL_MOMENT, 0);
  };

  measure();
  onWidthChange(() => {
    water.resize();
    ripples.reset(water.width);
    measure();
    if (reducedMotion) drawStill();
  });

  if (reducedMotion) {
    new Bubble(chatBoat).show([CHATS[0].question], false);
    drawStill();
    return;
  }
  animateWhileVisible(host, draw);
  followPointer(hero, host, ripples);
  voyage.run();
}
