import { expect, test } from "bun:test";
import { lineChanges } from "../src/web/revision-history";

test("revision changes omit unchanged lines", () => {
  expect(lineChanges("First\nKeep\nOld", "First\nKeep\nNew")).toEqual([
    { kind: "removed", lines: ["Old"] },
    { kind: "added", lines: ["New"] },
  ]);
});

test("revision changes retain added and removed blocks", () => {
  expect(lineChanges("A\nB\nC", "A\nNew one\nNew two\nC")).toEqual([
    { kind: "removed", lines: ["B"] },
    { kind: "added", lines: ["New one", "New two"] },
  ]);
});

test("large revisions still omit their unchanged beginning and end", () => {
  const shared = Array.from({ length: 600 }, (_, index) => `Line ${index}`);
  expect(
    lineChanges(
      [...shared, "Before", ...shared].join("\n"),
      [...shared, "After", ...shared].join("\n"),
    ),
  ).toEqual([
    { kind: "removed", lines: ["Before"] },
    { kind: "added", lines: ["After"] },
  ]);
});
