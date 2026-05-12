import { MeetingScheduler } from "../scheduler.js";

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createSettings() {
  return {
    get_boolean() {
      return true;
    },
    get_int(key) {
      if (key === "alert-minutes-before") return 5;
      if (key === "alert-horizon-hours") return 24;
      if (key === "default-snooze-minutes") return 10;
      return 0;
    },
    get_strv() {
      return ["calendar-1"];
    },
    get_string() {
      return "";
    },
  };
}

function createScheduler() {
  const overlay = {
    showCalls: [],
    hideCalls: 0,
    show(event, handlers, options = {}) {
      this.showCalls.push({ event, handlers, options });
      this._lastClosed = options.onClosed ?? null;
    },
    hide() {
      this.hideCalls++;
    },
    triggerClosed() {
      this._lastClosed?.();
    },
  };

  const backend = {
    setEventsChangedCallback() {},
    stop() {},
    refresh() {
      return Promise.resolve();
    },
  };

  const scheduler = new MeetingScheduler(createSettings(), backend, overlay);
  scheduler._running = true;
  scheduler._visibleEvents = [];

  return { scheduler, overlay };
}

function event(id, title) {
  return {
    id,
    title,
    startEpochSeconds: 1700000000,
    endEpochSeconds: 1700003600,
    sourceName: "Work",
    sourceId: "calendar-1",
    meetingUrl: "",
  };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("queues a second in-progress alert until the first overlay closes", () => {
  const { scheduler, overlay } = createScheduler();
  const first = event("event-1", "First");
  const second = event("event-2", "Second");
  scheduler._visibleEvents = [first, second];

  scheduler._showAlert(first, true, false);
  scheduler._showAlert(second, true, false);

  assertEqual(
    overlay.showCalls.length,
    1,
    "only the first overlay should show immediately",
  );
  assertEqual(overlay.showCalls[0].event.id, "event-1", "first overlay event");

  overlay.triggerClosed();

  assertEqual(
    overlay.showCalls.length,
    2,
    "second overlay should show after close",
  );
  assertEqual(overlay.showCalls[1].event.id, "event-2", "queued overlay event");
});

test("does not drain queued alerts after stop", () => {
  const { scheduler, overlay } = createScheduler();
  const first = event("event-1", "First");
  const second = event("event-2", "Second");
  scheduler._visibleEvents = [first, second];

  scheduler._showAlert(first, true, false);
  scheduler._showAlert(second, true, false);

  scheduler.stop();
  overlay.triggerClosed();

  assertEqual(
    overlay.showCalls.length,
    1,
    "queued overlay should not show after stop",
  );
  assertEqual(
    scheduler._pendingAlertEventIds.length,
    0,
    "queue should be cleared on stop",
  );
});

test("manual alert shows overlay even when the event has no join URL", () => {
  const { scheduler, overlay } = createScheduler();
  const item = event("event-1", "No Join");
  scheduler._visibleEvents = [item];

  scheduler.showAlertForEvent("event-1");

  assertEqual(overlay.showCalls.length, 1, "overlay should show");
  assertEqual(overlay.showCalls[0].event.id, "event-1", "event id");
  assertEqual(
    overlay.showCalls[0].event.joinUrl,
    "",
    "join url should remain empty",
  );
  assertEqual(
    overlay.showCalls[0].options.triggerSource,
    "manual",
    "manual trigger",
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

if (failures > 0) throw new Error(`${failures} scheduler test(s) failed`);

print(`${tests.length} scheduler tests passed`);
