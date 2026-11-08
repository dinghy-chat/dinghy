const HEIGHT_PER_WIDTH = 120 / 140;

/** The large boat. It has more detail than the logo, and its sails and pennant are animated in CSS. */
function boatArt({ main = "#e5352b", jib = "#fff8df", returning = false }) {
  const pennant = returning ? "96 11 72 18" : "90 10 72 15";
  const pennantColor = returning ? "#ffc917" : "#1f6bff";
  return `<svg viewBox="0 0 140 120" aria-hidden="true">
    <path class="sail-jib" d="M65 22C52 37 36 56 24 74H65z" fill="${jib}"/>
    <path d="M65 38C56 49 47 60 39 72M65 56C60 62 56 68 52 73" fill="none" stroke="#0b2239" stroke-opacity=".14" stroke-width="1.5"/>
    <path class="sail-main" d="M73 12C98 28 116 52 121 74H73z" fill="${main}"/>
    <path d="M73 32C88 42 100 56 106 73M73 52C82 58 88 66 92 73" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="1.5"/>
    <rect x="67" y="4" width="5" height="84" rx="2" fill="#0b2239"/>
    <path class="pennant" d="M72 5 ${pennant}z" fill="${pennantColor}"/>
    <rect x="70" y="74" width="54" height="3.5" rx="1.7" fill="#0b2239"/>
    <circle cx="46" cy="76" r="5.5" fill="#ffd9b3"/>
    <path d="M40 75a6 6 0 0 1 12 0z" fill="#0b2239"/>
    <rect x="42" y="80" width="8" height="7" rx="2" fill="#1f6bff"/>
    <path d="M8 85C40 90 100 90 132 80 127 101 110 114 88 114H50C30 114 15 103 8 85z" fill="#0b2239"/>
    <path d="M8 85C40 90 100 90 132 80L130.5 85C100 95 40 95 9.5 90z" fill="#fff8df"/>
    <circle cx="58" cy="100" r="3.5" fill="#fff8df"/>
    <circle cx="74" cy="100" r="3.5" fill="#fff8df"/>
    <circle cx="90" cy="99" r="3.5" fill="#fff8df"/>
  </svg>`;
}

/** A boat element placed on the water. The water module moves it each frame. */
export class Boat {
  constructor(parent, size, colors = {}) {
    this.colors = colors;
    this.element = document.createElement("span");
    this.element.className = "boat";
    this.hull = document.createElement("span");
    this.hull.className = "boat-art";
    this.hull.innerHTML = boatArt(colors);
    this.element.append(this.hull);
    parent.append(this.element);
    this.setSize(size);
  }

  setSize(size) {
    this.size = size;
    this.height = size * HEIGHT_PER_WIDTH;
    this.element.style.setProperty("width", `${size}px`);
  }

  /** Points the boat east or west. It flies a yellow pennant on the way back with an answer. */
  turn(direction, returning) {
    this.direction = direction;
    this.element.classList.toggle("is-reversed", direction < 0);
    this.hull.innerHTML = boatArt({ ...this.colors, returning });
  }

  place(x, y, angle) {
    this.element.style.transform = `translate(${(x - this.size / 2).toFixed(1)}px,${y.toFixed(1)}px)`;
    this.hull.style.transform = `rotate(${angle.toFixed(2)}deg)`;
  }
}
