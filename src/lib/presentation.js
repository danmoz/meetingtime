import {
  formatEventTimeRange,
  formatRelativeTime,
  formatWeekday,
  NO_EVENTS_LABELS,
} from "./util.js";

const MAX_TITLE_LENGTH = 24;
const MAX_SECTION_EVENTS = 12;
const RANDOM_NO_EVENTS_LABELS = NO_EVENTS_LABELS.filter(
  (label) => label !== "(random)",
);
const OVERLAY_BUTTON_ORDER = ["join", "ignore", "dismiss", "snooze"];

function _truncateTitle(title) {
  const text = String(title ?? "");
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH - 3)}...`
    : text;
}

function _isToday(epochSeconds, now) {
  const eventDate = new Date(epochSeconds * 1000);
  const nowDate = new Date(now * 1000);
  return (
    eventDate.getFullYear() === nowDate.getFullYear() &&
    eventDate.getMonth() === nowDate.getMonth() &&
    eventDate.getDate() === nowDate.getDate()
  );
}

function _formatDayLabel(epochSeconds, now) {
  const eventDate = new Date(epochSeconds * 1000);
  const nowDate = new Date(now * 1000);
  const todayKey = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  const eventKey = new Date(
    eventDate.getFullYear(),
    eventDate.getMonth(),
    eventDate.getDate(),
  ).getTime();
  const dayDiff = Math.round((eventKey - todayKey) / 86400000);

  if (dayDiff === 0) return "";
  if (dayDiff === 1) return "Tomorrow";

  return formatWeekday(epochSeconds);
}

function _getMostRecentlyStartedInProgressEvent(events, now) {
  let latestEvent = null;

  for (const event of events) {
    if (event.startEpochSeconds > now || event.endEpochSeconds <= now) continue;

    if (!latestEvent || event.startEpochSeconds > latestEvent.startEpochSeconds)
      latestEvent = event;
  }

  return latestEvent;
}

function _resolveNoEventsLabel(noEventsLabel) {
  const selectedLabel = noEventsLabel || NO_EVENTS_LABELS[0];
  if (selectedLabel !== "(random)") return selectedLabel;

  return RANDOM_NO_EVENTS_LABELS[
    Math.floor(Math.random() * RANDOM_NO_EVENTS_LABELS.length)
  ];
}

function _formatUpcomingEvent(event, now) {
  return {
    event,
    title: _truncateTitle(event.title),
    relativeTime: _isToday(event.startEpochSeconds, now)
      ? formatRelativeTime(event.startEpochSeconds, now)
      : "",
  };
}

function _formatInProgressEvent(event) {
  return {
    event,
    title: _truncateTitle(event.title),
    canJoin: Boolean(event.meetingUrl),
  };
}

function _groupUpcomingEvents(events, now) {
  const groupedEvents = new Map();
  for (const event of events) {
    const dayKey = new Date(event.startEpochSeconds * 1000).toDateString();
    const bucket = groupedEvents.get(dayKey) ?? {
      label: _formatDayLabel(event.startEpochSeconds, now),
      events: [],
    };
    bucket.events.push(_formatUpcomingEvent(event, now));
    groupedEvents.set(dayKey, bucket);
  }

  return Array.from(groupedEvents.values()).map((group) => ({
    label: group.label,
    events: group.events.slice(0, MAX_SECTION_EVENTS),
  }));
}

function _buildPresentation(
  label,
  {
    showDisabledMessage = false,
    showNoEventsMessage = false,
    upcomingEvents = [],
    inProgressEvents = [],
    now,
  },
) {
  return {
    label,
    showDisabledMessage,
    showNoEventsMessage,
    upcomingGroups: _groupUpcomingEvents(upcomingEvents, now),
    inProgressEvents: inProgressEvents
      .slice(0, MAX_SECTION_EVENTS)
      .map(_formatInProgressEvent),
  };
}

function _deriveOverlayButtons({ canJoin, showSnooze, snoozeMinutes }) {
  const buttons = {
    join: {
      action: "join",
      label: "Join",
      shortcutLabel: "J or Enter",
      visible: canJoin,
      isDefault: canJoin,
    },
    ignore: {
      action: "ignore",
      label: "Ignore",
      shortcutLabel: "I",
      visible: true,
      isDefault: false,
    },
    dismiss: {
      action: "dismiss",
      label: "Dismiss",
      shortcutLabel: "D or Escape",
      visible: true,
      isDefault: false,
    },
    snooze: {
      action: "snooze",
      label: `Snooze ${snoozeMinutes} min`,
      shortcutLabel: "S",
      visible: showSnooze,
      isDefault: !canJoin && showSnooze,
    },
  };

  return OVERLAY_BUTTON_ORDER.map((action) => buttons[action]).filter(
    (button) => button.visible,
  );
}

export function deriveMeetingPresentation({
  events,
  status,
  enabled,
  noEventsLabel,
  now,
}) {
  const visibleEvents = events ?? [];
  const widgetStatus = status?.widgetStatus || "loading";
  const loading = widgetStatus === "loading";
  const disabled = widgetStatus === "disabled";
  const inProgressEvent = _getMostRecentlyStartedInProgressEvent(
    visibleEvents,
    now,
  );
  const nextEvent =
    visibleEvents.find((event) => event.startEpochSeconds > now) ?? null;
  const activeEvent = inProgressEvent ?? nextEvent ?? visibleEvents[0] ?? null;
  const upcomingEvents = visibleEvents.filter(
    (event) => event.startEpochSeconds > now,
  );
  const inProgressEvents = visibleEvents.filter(
    (event) => event.startEpochSeconds <= now && event.endEpochSeconds > now,
  );
  const eventSections = { upcomingEvents, inProgressEvents, now };

  if (disabled) {
    return _buildPresentation("Disabled", {
      showDisabledMessage: true,
      now,
    });
  }

  if (loading && inProgressEvent) {
    return _buildPresentation(
      `${_truncateTitle(inProgressEvent.title)} (now)`,
      eventSections,
    );
  }

  if (loading) {
    return _buildPresentation("Loading...", eventSections);
  }

  if (!enabled) {
    return _buildPresentation("Paused", eventSections);
  }

  if (!activeEvent) {
    return _buildPresentation(_resolveNoEventsLabel(noEventsLabel), {
      showNoEventsMessage: true,
      now,
    });
  }

  if (inProgressEvent) {
    return _buildPresentation(
      `${_truncateTitle(inProgressEvent.title)} (now)`,
      eventSections,
    );
  }

  return _buildPresentation(
    `${_truncateTitle(activeEvent.title)} (${formatRelativeTime(activeEvent.startEpochSeconds, now)})`,
    eventSections,
  );
}

export function deriveOverlayPresentation(event, now, options = {}) {
  const hasStarted = event.startEpochSeconds <= now;
  const canJoin = Boolean(event.joinUrl);
  const snoozeMinutes = options.snoozeMinutes ?? 5;
  const showSnooze = options.triggerSource !== "manual";

  return {
    heading: hasStarted ? "Event started" : "Event starting soon",
    title: event.title,
    meta: `${formatEventTimeRange(event)}   ${event.sourceName}`,
    location: event.location ?? "",
    canJoin,
    buttons: _deriveOverlayButtons({ canJoin, showSnooze, snoozeMinutes }),
    countdown: `${hasStarted ? "Started" : "Starts"} ${formatRelativeTime(event.startEpochSeconds, now)}`,
  };
}
