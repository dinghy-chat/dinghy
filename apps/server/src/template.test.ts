import { describe, expect, test } from "vitest";
import { renderTemplate, templateProblems } from "./template.ts";

const values: Record<string, unknown> = {
  firstName: "Ada",
  "attributes.plan": "pro",
  "attributes.seats": 12,
  empty: "",
};
const lookup = (path: string) => values[path];

describe("renderTemplate", () => {
  test("fills variables and runs the filters in order", () => {
    expect(renderTemplate("Hi {{ firstName }}, on {{attributes.plan|upcase}}", lookup)).toBe(
      "Hi Ada, on PRO",
    );
    expect(renderTemplate("{{ attributes.seats }} seats", lookup)).toBe("12 seats");
    expect(renderTemplate('{{ nickname | default: "there" | upcase }}', lookup)).toBe("THERE");
    expect(renderTemplate("{{ firstName | downcase | append: '!' }}", lookup)).toBe("ada!");
  });

  test("prepend and append leave an empty value empty", () => {
    expect(renderTemplate('Bonjour{{ firstName | prepend: " " }},', lookup)).toBe("Bonjour Ada,");
    expect(renderTemplate('Bonjour{{ empty | prepend: " " }},', lookup)).toBe("Bonjour,");
    expect(renderTemplate('{{ missing | append: "?" }}', lookup)).toBe("");
  });

  test("leaves a tag that does not read as it is", () => {
    expect(renderTemplate("{{ firstName | shout }}", lookup)).toBe("{{ firstName | shout }}");
  });
});

describe("templateProblems", () => {
  const knows = (path: string) => path === "firstName";

  test("names unknown variables, unknown filters and missing arguments", () => {
    expect(templateProblems("Hi {{ firstName | default: 'you' }}", knows)).toEqual([]);
    expect(templateProblems("{{ nickname }}", knows)).toEqual(["Unknown variable nickname"]);
    expect(templateProblems("{{ firstName | shout }}", knows)).toEqual(['Unknown filter "shout"']);
    expect(templateProblems("{{ firstName | default }}", knows)).toEqual([
      "The filter default takes text in quotes",
    ]);
    expect(templateProblems("{{ firstName | upcase: 'x' }}", knows)).toEqual([
      "The filter upcase takes no text in quotes",
    ]);
    expect(templateProblems("{{ }}", knows)).toEqual(['"{{ }}" names no variable']);
  });
});
