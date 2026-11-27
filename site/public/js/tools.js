// The free tools: a content page, plus the calculator on it.
import "./page.js";
import { aht, csat, downtimeFor, formatDuration, nps, staffing, uptimeFor } from "./tool-math.js";

const numberText = (value, digits = 1) =>
  Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
const percentText = (value, digits = 1) => `${numberText(value, digits)}%`;
const signedText = (value) => (value > 0 ? `+${numberText(value)}` : numberText(value));

/** Each tool reads its inputs by name and returns the text for each [data-out], or null when they make no sense. */
const TOOLS = {
  nps: (input) => {
    const result = nps(input.promoters, input.passives, input.detractors);
    return (
      result && {
        score: signedText(result.score),
        promoters: percentText(result.promoters),
        passives: percentText(result.passives),
        detractors: percentText(result.detractors),
        total: numberText(result.total, 0),
      }
    );
  },
  csat: (input) => {
    const result = csat(input.satisfied, input.total);
    return result === null ? null : { score: percentText(result) };
  },
  aht: (input) => {
    const minutes = aht(input.chat, input.wrapUp, input.conversations);
    return (
      minutes !== null && {
        aht: formatDuration(minutes * 60),
        minutes: numberText(minutes, 2),
      }
    );
  },
  uptime: (input) => {
    if (input.uptime < 0 || input.uptime > 100) return null;
    const down = downtimeFor(input.uptime);
    return {
      day: formatDuration(down.day),
      week: formatDuration(down.week),
      month: formatDuration(down.month),
      year: formatDuration(down.year),
    };
  },
  downtime: (input) => {
    const seconds = input.hours * 3600 + input.minutes * 60 + input.seconds;
    const result = uptimeFor(seconds, input.period);
    if (result === null) return null;
    const uptime = percentText(result, 4);
    return { uptime: seconds > 0 && uptime === "100%" ? "over 99.9999%" : uptime };
  },
  staffing: (input) => {
    const result = staffing(input);
    return (
      result && {
        agents: numberText(result.agents, 0),
        scheduled: numberText(result.scheduled, 0),
        serviceLevel: percentText(result.serviceLevel),
        wait: formatDuration(result.averageWaitSeconds),
        occupancy: percentText(result.occupancy, 0),
      }
    );
  },
};

/** The inputs by name, or null when a field is empty or breaks its min, max or step. */
function readInputs(tool) {
  const input = {};
  for (const field of tool.querySelectorAll("input[name], select[name]")) {
    if (field.value === "" || !field.validity.valid) return null;
    input[field.name] = field.type === "number" ? field.valueAsNumber : field.value;
  }
  return input;
}

function update(tool, calculate) {
  const input = readInputs(tool);
  const output = input && calculate(input);
  const error = tool.querySelector("[data-error]");
  if (error) error.hidden = Boolean(output);
  tool.classList.toggle("is-invalid", !output);
  for (const target of tool.querySelectorAll("[data-out]")) {
    target.textContent = output?.[target.dataset.out] ?? "";
  }
}

for (const tool of document.querySelectorAll("[data-tool]")) {
  const calculate = TOOLS[tool.dataset.tool];
  if (!calculate) continue;
  tool.addEventListener("input", () => update(tool, calculate));
  tool.addEventListener("change", () => update(tool, calculate));
  update(tool, calculate);
}
