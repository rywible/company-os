import { expect, test } from "bun:test";
import { nextCronOccurrence, validCron } from "../src/domain/cron";

test("cron schedules use standard five-field UTC syntax", () => {
  expect(validCron("0 9 * * 1-5")).toBe(true);
  expect(validCron("0 9 * * 7")).toBe(true);
  expect(validCron("every weekday")).toBe(false);
  expect(nextCronOccurrence("0 9 * * 1-5", "2026-09-18T10:00:00.000Z")).toBe(
    "2026-09-21T09:00:00.000Z",
  );
});
