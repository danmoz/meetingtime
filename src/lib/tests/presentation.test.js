import {
  deriveMeetingPresentation,
  deriveOverlayPresentation,
} from "../presentation.js";
import { NO_EVENTS_LABELS } from "../util.js";

const NOW = 1700000000;

function event(overrides = {}) {
  return {
    id: overrides.id ?? "event-1",
    title: overrides.title ?? "Planning",
    startEpochSeconds: overrides.startEpochSeconds ?? NOW + 600,
    endEpochSeconds: overrides.endEpochSeconds ?? NOW + 1800,
    sourceName: overrides.sourceName ?? "Work",
    meetingUrl: overrides.meetingUrl ?? "",
    joinUrl: overrides.joinUrl ?? "",
    location: overrides.location ?? "",
  };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson)
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function derive(overrides = {}) {
  return deriveMeetingPresentation({
    events: overrides.events ?? [],
    status: overrides.status ?? { widgetStatus: "ready" },
    enabled: overrides.enabled ?? true,
    noEventsLabel: overrides.noEventsLabel ?? "No events",
    now: overrides.now ?? NOW,
  });
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("disabled calendars produce disabled status without event sections", () => {
  const result = derive({
    events: [event()],
    status: { widgetStatus: "disabled" },
  });

  assertEqual(result.label, "Disabled", "label");
  assertEqual(result.showDisabledMessage, true, "disabled message");
  assertEqual(result.showNoEventsMessage, false, "no-events message");
  assertEqual(result.upcomingGroups.length, 0, "upcoming groups");
  assertEqual(result.inProgressEvents.length, 0, "in-progress events");
});

test("loading state still surfaces an in-progress event label and rows", () => {
  const active = event({
    id: "active",
    title: "Long Running Review",
    startEpochSeconds: NOW - 300,
    endEpochSeconds: NOW + 900,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  });
  const future = event({
    id: "future",
    title: "Later Planning",
    startEpochSeconds: NOW + 1200,
    endEpochSeconds: NOW + 1800,
  });

  const result = derive({
    events: [active, future],
    status: { widgetStatus: "loading" },
  });

  assertEqual(result.label, "Long Running Review (now)", "label");
  assertEqual(result.inProgressEvents.length, 1, "in-progress row count");
  assertEqual(
    result.inProgressEvents[0].event.id,
    "active",
    "in-progress event",
  );
  assertEqual(
    result.inProgressEvents[0].canJoin,
    true,
    "in-progress join state",
  );
  assertEqual(result.upcomingGroups.length, 1, "upcoming groups");
  assertEqual(
    result.upcomingGroups[0].events[0].event.id,
    "future",
    "future event",
  );
});

test("empty ready state uses configured no-events label", () => {
  const result = derive({
    events: [],
    noEventsLabel: "All clear",
  });

  assertEqual(result.label, "All clear", "label");
  assertEqual(result.showNoEventsMessage, true, "no-events message");
  assertEqual(result.showDisabledMessage, false, "disabled message");
});

test("random no-events label never returns the random sentinel", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;

  try {
    const result = derive({
      events: [],
      noEventsLabel: "(random)",
    });

    assert(result.label !== "(random)", "label should not expose the sentinel");
    assert(
      NO_EVENTS_LABELS.includes(result.label),
      "label should come from the allowed list",
    );
  } finally {
    Math.random = originalRandom;
  }
});

test("upcoming events are grouped by day and formatted for the menu", () => {
  const today = event({
    id: "today",
    title: "Today Planning",
    startEpochSeconds: NOW + 600,
    endEpochSeconds: NOW + 1200,
  });
  const tomorrow = event({
    id: "tomorrow",
    title: "Tomorrow Planning",
    startEpochSeconds: NOW + 86400,
    endEpochSeconds: NOW + 87000,
  });

  const result = derive({
    events: [today, tomorrow],
  });

  assertEqual(result.label, "Today Planning (in 10m)", "label");
  assertEqual(result.upcomingGroups.length, 2, "group count");
  assertEqual(result.upcomingGroups[0].label, "", "today group label");
  assertDeepEqual(
    result.upcomingGroups[0].events.map((item) => [
      item.event.id,
      item.title,
      item.relativeTime,
    ]),
    [["today", "Today Planning", "in 10m"]],
    "today event view",
  );
  assertEqual(
    result.upcomingGroups[1].label,
    "Tomorrow",
    "tomorrow group label",
  );
  assertEqual(
    result.upcomingGroups[1].events[0].relativeTime,
    "",
    "tomorrow relative time",
  );
});

test("menu sections are limited to twelve events", () => {
  const events = Array.from({ length: 13 }, (_unused, index) =>
    event({
      id: `event-${index}`,
      title: `Event ${index}`,
      startEpochSeconds: NOW + 600 + index * 60,
      endEpochSeconds: NOW + 1200 + index * 60,
    }),
  );

  const result = derive({ events });

  assertEqual(result.upcomingGroups.length, 1, "group count");
  assertEqual(
    result.upcomingGroups[0].events.length,
    12,
    "visible event count",
  );
  assertEqual(
    result.upcomingGroups[0].events[11].event.id,
    "event-11",
    "last visible event",
  );
});

test("long indicator titles are truncated consistently", () => {
  const result = derive({
    events: [
      event({ title: "This title is much longer than the panel should show" }),
    ],
  });

  assertEqual(result.label, "This title is much lo... (in 10m)", "label");
  assertEqual(
    result.upcomingGroups[0].events[0].title,
    "This title is much lo...",
    "menu title",
  );
});

test("paused alerts produce paused label while keeping menu events visible", () => {
  const result = derive({
    enabled: false,
    events: [event()],
  });

  assertEqual(result.label, "Paused", "label");
  assertEqual(result.upcomingGroups.length, 1, "upcoming groups");
  assertEqual(result.showNoEventsMessage, false, "no-events message");
});

test("overlay presentation derives started text and join visibility", () => {
  const result = deriveOverlayPresentation(
    event({
      title: "Release Review",
      startEpochSeconds: NOW - 120,
      endEpochSeconds: NOW + 1800,
      sourceName: "Engineering",
      location: "Room 3",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    }),
    NOW,
  );

  assertEqual(result.heading, "Event started", "heading");
  assertEqual(result.title, "Release Review", "title");
  assertEqual(result.location, "Room 3", "location");
  assertEqual(result.canJoin, true, "join state");
  assertDeepEqual(
    result.buttons.map((button) => [
      button.action,
      button.label,
      button.isDefault,
    ]),
    [
      ["join", "Join", true],
      ["ignore", "Ignore", false],
      ["dismiss", "Dismiss", false],
      ["snooze", "Snooze 5 min", false],
    ],
    "button order",
  );
  assertEqual("canIgnore" in result, false, "ignore state removed");
  assertEqual("shortcuts" in result, false, "shortcut metadata removed");
  assertEqual(result.countdown, "Started 2m ago", "countdown");
  assert(result.meta.endsWith("   Engineering"), "meta includes source name");
});

test("overlay presentation derives upcoming text without join", () => {
  const result = deriveOverlayPresentation(
    event({
      startEpochSeconds: NOW + 300,
      endEpochSeconds: NOW + 900,
    }),
    NOW,
    { snoozeMinutes: 12 },
  );

  assertEqual(result.heading, "Event starting soon", "heading");
  assertEqual(result.canJoin, false, "join state");
  assertDeepEqual(
    result.buttons.map((button) => [
      button.action,
      button.label,
      button.isDefault,
    ]),
    [
      ["ignore", "Ignore", false],
      ["dismiss", "Dismiss", false],
      ["snooze", "Snooze 12 min", true],
    ],
    "button order",
  );
  assertEqual("shortcuts" in result, false, "shortcut metadata removed");
  assertEqual(result.countdown, "Starts in 5m", "countdown");
});

test("overlay presentation hides snooze for manually triggered alerts", () => {
  const result = deriveOverlayPresentation(
    event({
      startEpochSeconds: NOW + 300,
      endEpochSeconds: NOW + 900,
    }),
    NOW,
    {
      snoozeMinutes: 12,
      triggerSource: "manual",
    },
  );

  assertDeepEqual(
    result.buttons.map((button) => [
      button.action,
      button.label,
      button.isDefault,
    ]),
    [
      ["ignore", "Ignore", false],
      ["dismiss", "Dismiss", false],
    ],
    "button order",
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

if (failures > 0) throw new Error(`${failures} presentation test(s) failed`);

print(`${tests.length} presentation tests passed`);
