import { inferAllDayEvent } from "../calendarBackend.js";

function localEpochSeconds(year, monthIndex, day, hour = 0, minute = 0) {
  return Math.floor(
    new Date(year, monthIndex, day, hour, minute).getTime() / 1000,
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("detects explicit all-day flags from common CalendarServer key shapes", () => {
  const start = localEpochSeconds(2026, 4, 8, 10);
  const end = localEpochSeconds(2026, 4, 8, 11);

  assertEqual(
    inferAllDayEvent(start, end, { all_day: true }),
    true,
    "snake case",
  );
  assertEqual(
    inferAllDayEvent(start, end, { "all-day": true }),
    true,
    "kebab case",
  );
  assertEqual(
    inferAllDayEvent(start, end, { allDay: true }),
    true,
    "camel case",
  );
  assertEqual(
    inferAllDayEvent(start, end, { isAllDay: "true" }),
    true,
    "string boolean",
  );
});

test("detects midnight-to-midnight local spans as all-day", () => {
  const start = localEpochSeconds(2026, 4, 8);
  const end = localEpochSeconds(2026, 4, 9);

  assertEqual(inferAllDayEvent(start, end, {}), true, "single day");
});

test("detects multi-day midnight-to-midnight local spans as all-day", () => {
  const start = localEpochSeconds(2026, 4, 8);
  const end = localEpochSeconds(2026, 4, 10);

  assertEqual(inferAllDayEvent(start, end, {}), true, "multi day");
});

test("does not mark normal timed events as all-day", () => {
  const start = localEpochSeconds(2026, 4, 8, 9);
  const end = localEpochSeconds(2026, 4, 8, 10);

  assertEqual(inferAllDayEvent(start, end, {}), false, "timed event");
});

test("does not mark non-midnight twenty-four-hour events as all-day", () => {
  const start = localEpochSeconds(2026, 4, 8, 9);
  const end = localEpochSeconds(2026, 4, 9, 9);

  assertEqual(
    inferAllDayEvent(start, end, {}),
    false,
    "twenty-four hour timed event",
  );
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    print(`ok - ${name}`);
  } catch (error) {
    failures++;
    printerr(`not ok - ${name}`);
    printerr(error.stack ?? error.message);
  }
}

if (failures > 0)
  throw new Error(`${failures} calendar backend test(s) failed`);

print(`${tests.length} calendar backend tests passed`);
