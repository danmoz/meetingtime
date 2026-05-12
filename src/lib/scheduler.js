import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  extractMeetingUrl,
  maybePlayAlertSound,
  nowEpochSeconds,
  openUri,
} from "./util.js";

export class MeetingScheduler {
  constructor(settings, backend, overlay) {
    this._settings = settings;
    this._backend = backend;
    this._overlay = overlay;

    this._allEvents = [];
    this._visibleEvents = [];
    this._calendarMap = new Map();
    this._alertedEventIds = new Set();
    this._ignoredEventIds = new Set();
    this._recentAlertKeys = new Map();
    this._eventTimerIds = new Map();
    this._snoozeTimerIds = new Map();
    this._pendingAlertEventIds = [];
    this._activeAlertEventId = null;

    this._settingsSignalIds = [];
    this._refreshTimerId = 0;
    this._sleepSignalId = 0;
    this._running = false;
    this._refreshInFlight = false;
    this._refreshQueued = false;
    this._waitingForCalendarRefresh = false;
    this._firstSyncCompleted = false;

    this._onEventsChanged = null;
  }

  setEventsChangedCallback(callback) {
    this._onEventsChanged = callback;
  }

  start() {
    if (this._running) return;

    this._running = true;
    log("[MeetingTime] Scheduler starting");

    this._backend.setEventsChangedCallback((events, calendars, status = {}) => {
      this._allEvents = events;
      this._calendarMap = calendars ?? new Map();
      if (status.hasCompletedInitialRefresh) this._firstSyncCompleted = true;

      if (
        this._refreshInFlight ||
        this._refreshQueued ||
        this._waitingForCalendarRefresh
      )
        this._waitingForCalendarRefresh = false;

      this._applyFiltersAndSchedule();
    });
    this._backend.start();

    const rescheduleKeys = [
      "enabled",
      "alert-minutes-before",
      "alert-horizon-hours",
      "exclude-all-day-events",
    ];
    for (const key of rescheduleKeys) {
      const id = this._settings.connect(`changed::${key}`, () => {
        this._applyFiltersAndSchedule();
        this.forceRefresh();
      });
      this._settingsSignalIds.push(id);
    }

    const selectionRefreshId = this._settings.connect(
      "changed::enabled-calendar-uids",
      () => {
        this._waitingForCalendarRefresh = true;
        this._applyFiltersAndSchedule();
        this.forceRefresh();
      },
    );
    this._settingsSignalIds.push(selectionRefreshId);

    const refreshId = this._settings.connect(
      "changed::refresh-interval-minutes",
      () => {
        this._restartRefreshTimer();
      },
    );
    this._settingsSignalIds.push(refreshId);

    const forceRefreshId = this._settings.connect(
      "changed::force-refresh-request",
      () => {
        this.forceRefresh();
      },
    );
    this._settingsSignalIds.push(forceRefreshId);

    this._sleepSignalId = Gio.DBus.system.signal_subscribe(
      "org.freedesktop.login1",
      "org.freedesktop.login1.Manager",
      "PrepareForSleep",
      "/org/freedesktop/login1",
      null,
      Gio.DBusSignalFlags.NONE,
      (
        _connection,
        _senderName,
        _objectPath,
        _interfaceName,
        _signalName,
        params,
      ) => {
        const [sleeping] = params.deepUnpack();
        if (!sleeping) this.forceRefresh();
      },
    );

    this._restartRefreshTimer();
    this.forceRefresh();
  }

  stop() {
    if (!this._running) return;

    this._running = false;
    log("[MeetingTime] Scheduler stopping");

    this._overlay.hide();
    this._backend.stop();

    for (const id of this._settingsSignalIds) this._settings.disconnect(id);
    this._settingsSignalIds = [];

    if (this._sleepSignalId) {
      Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
      this._sleepSignalId = 0;
    }

    this._clearRefreshTimer();
    this._clearAllEventTimers();
    this._clearAllSnoozeTimers();
    this._alertedEventIds.clear();
    this._ignoredEventIds.clear();
    this._recentAlertKeys.clear();
    this._pendingAlertEventIds = [];
    this._activeAlertEventId = null;
  }

  async forceRefresh() {
    if (!this._running) return;

    if (this._refreshInFlight) {
      this._refreshQueued = true;
      return;
    }

    this._refreshInFlight = true;
    log("[MeetingTime] Force refresh requested");
    try {
      const windowHours = this._settings.get_int("alert-horizon-hours");
      const enabledCalendarIds = this._settings.get_strv(
        "enabled-calendar-uids",
      );
      await this._backend.refresh(windowHours, enabledCalendarIds);
    } catch (error) {
      logError(error, "[MeetingTime] Calendar refresh failed");
    } finally {
      this._refreshInFlight = false;
      if (this._refreshQueued) {
        this._refreshQueued = false;
        this.forceRefresh();
      }
    }
  }

  showAlertForEvent(eventId) {
    const event = this._visibleEvents.find((e) => e.id === eventId);
    if (!event) return;

    this._showAlert(event, true, false, "manual");
  }

  openEvent(eventId) {
    const event = this._visibleEvents.find((e) => e.id === eventId);
    if (!event) return;

    const url = extractMeetingUrl(event);
    openUri(url);
    this._markEventHandled(event.id);
  }

  _applyFiltersAndSchedule() {
    const now = nowEpochSeconds();
    const excludeAllDayEvents = this._settings.get_boolean(
      "exclude-all-day-events",
    );
    const horizonSeconds =
      Math.max(0, this._settings.get_int("alert-horizon-hours")) * 3600;
    const horizonCutoff = now + horizonSeconds;
    const enabledCalendarIds = this._settings.get_strv("enabled-calendar-uids");
    const allowedSet = new Set(enabledCalendarIds);

    const visibleEvents = [];
    let horizonDroppedCount = 0;
    for (const event of this._allEvents) {
      const reasons = [];

      if (this._ignoredEventIds.has(event.id)) reasons.push("ignored");
      if (event.endEpochSeconds < now) reasons.push("ended");
      if (event.startEpochSeconds > horizonCutoff)
        reasons.push("outside-horizon");
      if (excludeAllDayEvents && event.isAllDay)
        reasons.push("all-day-excluded");
      if (!event.sourceId) reasons.push("missing-source-id");
      else if (!allowedSet.has(event.sourceId))
        reasons.push(`calendar-disabled:${event.sourceId}`);

      if (reasons.length === 0) visibleEvents.push(event);
      else if (reasons.includes("outside-horizon")) horizonDroppedCount++;
    }

    visibleEvents.sort((a, b) => a.startEpochSeconds - b.startEpochSeconds);

    this._visibleEvents = visibleEvents;

    if (horizonDroppedCount > 0)
      log(
        `[MeetingTime] Dropped ${horizonDroppedCount} events outside alert horizon`,
      );

    this._pruneIgnoredEvents(now);

    for (const eventId of Array.from(this._alertedEventIds)) {
      const stillExists = this._visibleEvents.some(
        (event) => event.id === eventId,
      );
      if (!stillExists) this._alertedEventIds.delete(eventId);
    }

    this._scheduleAlerts();
    this._onEventsChanged?.(this._visibleEvents, this._calendarMap, {
      hasCompletedInitialRefresh: this._firstSyncCompleted,
      widgetStatus: this.getWidgetStatus(),
      selectedCalendarCount: enabledCalendarIds.length,
      discoveredCalendarCount: this._calendarMap.size,
    });
  }

  getWidgetStatus() {
    const enabledCalendarIds = this._settings.get_strv("enabled-calendar-uids");
    if (enabledCalendarIds.length === 0) return "disabled";
    if (!this._firstSyncCompleted) return "loading";
    if (this._waitingForCalendarRefresh) return "loading";

    return "ready";
  }

  _scheduleAlerts() {
    this._clearAllEventTimers();
    this._pendingAlertEventIds = [];

    if (!this._settings.get_boolean("enabled")) return;

    const now = nowEpochSeconds();
    const leadSeconds = this._settings.get_int("alert-minutes-before") * 60;

    for (const event of this._visibleEvents) {
      if (this._alertedEventIds.has(event.id)) continue;

      if (now >= event.endEpochSeconds) continue;

      const alertAt = event.startEpochSeconds - leadSeconds;
      if (now >= alertAt) {
        if (this._activeAlertEventId) {
          this._pendingAlertEventIds.push(event.id);
          continue;
        }

        this._showAlert(event, false);
        continue;
      }

      const delaySeconds = Math.max(1, alertAt - now);
      const timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        delaySeconds,
        () => {
          this._eventTimerIds.delete(event.id);
          this._showAlert(event, false);
          return GLib.SOURCE_REMOVE;
        },
      );
      this._eventTimerIds.set(event.id, timeoutId);
    }
  }

  _showAlert(event, force, playSound = true, triggerSource = "scheduled") {
    if (this._activeAlertEventId && this._activeAlertEventId !== event.id) {
      if (!this._pendingAlertEventIds.includes(event.id))
        this._pendingAlertEventIds.push(event.id);
      return;
    }

    const alertKey = this._makeAlertKey(event);
    this._pruneRecentAlertKeys();

    if (this._ignoredEventIds.has(event.id)) return;

    if (!force && this._alertedEventIds.has(event.id)) return;

    if (alertKey && !force && this._recentAlertKeys.has(alertKey)) return;

    if (alertKey) this._recentAlertKeys.set(alertKey, Date.now());

    this._markEventHandled(event.id);
    this._activeAlertEventId = event.id;
    if (playSound) {
      maybePlayAlertSound(this._settings.get_string("alert-sound-file"));
    }

    const joinUrl = extractMeetingUrl(event);
    this._overlay.show(
      { ...event, joinUrl },
      {
        onJoin: () => {
          openUri(joinUrl);
          this._overlay.hide();
        },
        onDismiss: () => {
          this._overlay.hide();
        },
        onIgnore: () => {
          this._ignoreEvent(event.id);
        },
        onSnooze: (minutes) => {
          this._overlay.hide();
          this._scheduleSnooze(event.id, minutes);
        },
      },
      {
        triggerSource,
        onClosed: () => {
          if (!this._running) return;

          if (this._activeAlertEventId === event.id)
            this._activeAlertEventId = null;
          this._showPendingAlert();
        },
      },
    );
  }

  _showPendingAlert() {
    if (!this._running) return;

    if (this._activeAlertEventId || this._pendingAlertEventIds.length === 0)
      return;

    const nextEventId = this._pendingAlertEventIds.shift();
    const nextEvent = this._visibleEvents.find(
      (event) => event.id === nextEventId,
    );
    if (!nextEvent) return this._showPendingAlert();

    this._showAlert(nextEvent, false);
  }

  _scheduleSnooze(eventId, minutes) {
    this._clearSnoozeTimer(eventId);

    const timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      Math.max(60, minutes * 60),
      () => {
        this._snoozeTimerIds.delete(eventId);
        this.showAlertForEvent(eventId);
        return GLib.SOURCE_REMOVE;
      },
    );
    this._snoozeTimerIds.set(eventId, timeoutId);
  }

  _ignoreEvent(eventId) {
    this._ignoredEventIds.add(eventId);
    this._markEventHandled(eventId);
    this._clearSnoozeTimer(eventId);
    this._overlay.hide();
    this._activeAlertEventId = null;
    this._applyFiltersAndSchedule();
  }

  _markEventHandled(eventId) {
    this._alertedEventIds.add(eventId);
    this._clearEventTimer(eventId);
  }

  _pruneIgnoredEvents(now) {
    for (const eventId of Array.from(this._ignoredEventIds)) {
      const event = this._allEvents.find(
        (candidate) => candidate.id === eventId,
      );
      if (event && event.endEpochSeconds < now)
        this._ignoredEventIds.delete(eventId);
    }
  }

  _makeAlertKey(event) {
    return [
      String(event.title ?? "")
        .trim()
        .toLowerCase(),
      Number(event.startEpochSeconds),
      Number(event.endEpochSeconds),
      String(event.sourceId ?? "")
        .trim()
        .toLowerCase(),
    ].join("|");
  }

  _pruneRecentAlertKeys() {
    const cutoff = Date.now() - 60000;
    for (const [key, timestamp] of this._recentAlertKeys.entries()) {
      if (timestamp < cutoff) this._recentAlertKeys.delete(key);
    }
  }

  _restartRefreshTimer() {
    this._clearRefreshTimer();

    const refreshMinutes = this._settings.get_int("refresh-interval-minutes");
    const seconds = Math.max(60, refreshMinutes * 60);

    this._refreshTimerId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      seconds,
      () => {
        this.forceRefresh();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _clearRefreshTimer() {
    if (!this._refreshTimerId) return;

    GLib.source_remove(this._refreshTimerId);
    this._refreshTimerId = 0;
  }

  _clearEventTimer(eventId) {
    const timeoutId = this._eventTimerIds.get(eventId);
    if (!timeoutId) return;

    GLib.source_remove(timeoutId);
    this._eventTimerIds.delete(eventId);
  }

  _clearAllEventTimers() {
    for (const timeoutId of this._eventTimerIds.values())
      GLib.source_remove(timeoutId);

    this._eventTimerIds.clear();
  }

  _clearSnoozeTimer(eventId) {
    const timeoutId = this._snoozeTimerIds.get(eventId);
    if (!timeoutId) return;

    GLib.source_remove(timeoutId);
    this._snoozeTimerIds.delete(eventId);
  }

  _clearAllSnoozeTimers() {
    for (const timeoutId of this._snoozeTimerIds.values())
      GLib.source_remove(timeoutId);

    this._snoozeTimerIds.clear();
  }
}
