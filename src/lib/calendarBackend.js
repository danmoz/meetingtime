// Calendar backend for MeetingTime.
//
// This module consumes GNOME Shell's CalendarServer D-Bus service, enriches
// events with EDS-backed metadata, and snapshots the in-memory calendar
// selection state on startup/shutdown.

import ECal from "gi://ECal?version=2.0";
import EDataServer from "gi://EDataServer?version=1.2";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { CalendarStartupSnapshot } from "./startupSnapshot.js";
import {
  extractGoogleMeetingUrl,
  extractMeetingUrl,
  nowEpochSeconds,
} from "./util.js";

const CALENDAR_SERVER_BUS_NAME = "org.gnome.Shell.CalendarServer";
const CALENDAR_SERVER_OBJECT_PATH = "/org/gnome/Shell/CalendarServer";
const CALENDAR_SERVER_INTERFACE = "org.gnome.Shell.CalendarServer";
const EDS_CONNECT_TIMEOUT_SECONDS = 2;
const _unresolvedCalendarIdentityLogIds = new Set();

function _normalizeLookupKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function _readDictionaryString(details, keys) {
  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(details, key) &&
      details[key] !== null &&
      details[key] !== undefined
    ) {
      return String(details[key]);
    }
  }
  return "";
}

function _deepUnpack(value) {
  if (value instanceof GLib.Variant) return _deepUnpack(value.deepUnpack());

  if (Array.isArray(value)) return value.map((item) => _deepUnpack(item));

  if (typeof value === "object" && value !== null) {
    const unpacked = {};
    for (const [key, item] of Object.entries(value))
      unpacked[key] = _deepUnpack(item);
    return unpacked;
  }

  return value;
}

function _findNestedString(value, candidateKeys) {
  if (value === null || value === undefined) return "";

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = _findNestedString(item, candidateKeys);
      if (found) return found;
    }
    return "";
  }

  if (typeof value !== "object") return "";

  const normalizedCandidates = new Set(candidateKeys.map(_normalizeLookupKey));

  for (const [key, item] of Object.entries(value)) {
    if (!normalizedCandidates.has(_normalizeLookupKey(key))) continue;

    const found = _findNestedString(item, candidateKeys);
    if (found) return found;
  }

  for (const item of Object.values(value)) {
    const found = _findNestedString(item, candidateKeys);
    if (found) return found;
  }

  return "";
}

function _findNestedObject(value, candidateKeys) {
  if (value === null || value === undefined || typeof value !== "object")
    return null;

  const normalizedCandidates = new Set(candidateKeys.map(_normalizeLookupKey));

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = _findNestedObject(item, candidateKeys);
      if (found) return found;
    }
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      normalizedCandidates.has(_normalizeLookupKey(key)) &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = _findNestedObject(item, candidateKeys);
    if (found) return found;
  }

  return null;
}

function _safeLogValue(value) {
  if (value === null || value === undefined) return "";

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);

  if (Array.isArray(value)) return `[array:${value.length}]`;

  return "[object]";
}

function _readBoolean(value) {
  if (typeof value === "boolean") return value;

  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }

  return false;
}

export function inferAllDayEvent(
  startEpochSeconds,
  endEpochSeconds,
  details = {},
) {
  const explicitAllDay = [
    details.all_day,
    details["all-day"],
    details.allDay,
    details.allday,
    details.is_all_day,
    details["is-all-day"],
    details.isAllDay,
    details.isallday,
  ].some(_readBoolean);

  if (explicitAllDay) return true;

  const start = Number(startEpochSeconds);
  const end = Number(endEpochSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return false;

  const durationSeconds = end - start;
  if (durationSeconds < 86400 || durationSeconds % 86400 !== 0) return false;

  const startDate = new Date(start * 1000);
  const endDate = new Date(end * 1000);
  return (
    startDate.getHours() === 0 &&
    startDate.getMinutes() === 0 &&
    startDate.getSeconds() === 0 &&
    endDate.getHours() === 0 &&
    endDate.getMinutes() === 0 &&
    endDate.getSeconds() === 0
  );
}

function _summarizeEventForLog(event) {
  return (
    `${event.title} [id=${event.id}, start=${event.startEpochSeconds}, ` +
    `end=${event.endEpochSeconds}, sourceId=${event.sourceId || "<missing>"}, ` +
    `sourceName=${event.sourceName || "<missing>"}, allDay=${event.isAllDay}]`
  );
}

function _logEventList(label, events) {
  log(`[MeetingTime] ${label}: count=${events.length}`);
  for (const event of events)
    log(`[MeetingTime] ${label}: ${_summarizeEventForLog(event)}`);
}

function _serializeEventSignature(events) {
  return JSON.stringify(
    events.map((event) => [
      event.id,
      event.title,
      event.startEpochSeconds,
      event.endEpochSeconds,
      event.sourceId || "",
      event.sourceName || "",
      event.meetingUrl || "",
      event.url || "",
      event.location || "",
      event.isAllDay ? 1 : 0,
    ]),
  );
}

function _describeMissingCalendarIdentity(details) {
  const topLevelKeys = Object.keys(details);
  const relatedEntries = Object.entries(details)
    .filter(([key]) => /(source|calendar)/i.test(key))
    .map(([key, value]) => `${key}=${_safeLogValue(value)}`);

  return { topLevelKeys, relatedEntries };
}

function _logMissingCalendarIdentity(event) {
  if (_unresolvedCalendarIdentityLogIds.has(event.id)) return;

  _unresolvedCalendarIdentityLogIds.add(event.id);

  const debug = event.calendarIdentityDebug ?? {
    topLevelKeys: [],
    relatedEntries: [],
  };

  log(
    "[MeetingTime] Calendar source missing for event " +
      `${event.id}; detail keys=[${debug.topLevelKeys.join(", ")}]; ` +
      `related=[${debug.relatedEntries.join(", ")}]`,
  );
}

function _normalizeMatchString(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function _makeUidMatchKey(value) {
  const normalized = _normalizeMatchString(value);
  return normalized ? `uid:${normalized}` : "";
}

function _makeUidMatchKeys(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const keys = new Set();
  const wholeKey = _makeUidMatchKey(raw);
  if (wholeKey) keys.add(wholeKey);

  for (const fragment of raw.split(/\s+/)) {
    const fragmentKey = _makeUidMatchKey(fragment);
    if (fragmentKey) keys.add(fragmentKey);
  }

  return Array.from(keys);
}

function _makeTitleTimeMatchKey(title, startEpochSeconds, endEpochSeconds) {
  const normalizedTitle = _normalizeMatchString(title);
  if (!normalizedTitle) return "";

  return `title-time:${normalizedTitle}:${Number(startEpochSeconds)}:${Number(endEpochSeconds)}`;
}

function _makeTitleStartMatchKey(title, startEpochSeconds) {
  const normalizedTitle = _normalizeMatchString(title);
  if (!normalizedTitle) return "";

  return `title-start:${normalizedTitle}:${Number(startEpochSeconds)}`;
}

function _extractEventSourceId(id) {
  const parts = String(id ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length > 0 ? parts[0] : "";
}

function _recordUniqueMatch(map, key, candidate) {
  if (!key) return;

  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, candidate);
    return;
  }

  if (existing === null) return;

  if (existing.sourceId !== candidate.sourceId) map.set(key, null);
}

function _findResolvedMatch(map, keys) {
  for (const key of keys) {
    const match = map.get(key);
    if (match) return match;
  }

  return null;
}

function _getSourceDisplayName(source) {
  return source.get_display_name() || "Calendar";
}

function _getSourceIdentity(source) {
  return {
    sourceId: source.get_uid(),
    sourceName: _getSourceDisplayName(source),
  };
}

function _firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }

  return "";
}

function _componentTextToString(text) {
  if (!text) return "";

  if (typeof text.get_value === "function")
    return String(text.get_value() ?? "").trim();

  return String(text ?? "").trim();
}

function _rawIcalFieldToString(rawComponent, getterName) {
  const getter = rawComponent?.[getterName];
  if (typeof getter !== "function") return "";

  const value = getter.call(rawComponent);
  if (typeof value === "string") return value.trim();

  if (value && typeof value.get_value === "function")
    return String(value.get_value() ?? "").trim();

  return String(value ?? "").trim();
}

function _flattenComponentDescriptions(component) {
  const descriptions = component.get_descriptions?.() ?? [];
  const parts = [];

  for (const text of descriptions) {
    const value = _componentTextToString(text);
    if (value) parts.push(value);
  }

  return parts.join("\n\n").trim();
}

function _extractMeetingUrlFromComponent(component) {
  const descriptionText = _flattenComponentDescriptions(component);
  const componentLocation = _firstNonEmptyString(component.get_location?.());
  const ical = component.get_icalcomponent?.();
  const icalDescription = _firstNonEmptyString(
    _rawIcalFieldToString(ical, "get_description"),
  );
  const icalLocation = _firstNonEmptyString(
    _rawIcalFieldToString(ical, "get_location"),
  );
  const rawDescription = descriptionText || icalDescription;
  const googleMeetingUrl = extractGoogleMeetingUrl(rawDescription);
  const candidate = {
    url: _firstNonEmptyString(component.get_url?.()),
    location: componentLocation || icalLocation,
    description: rawDescription,
  };

  return googleMeetingUrl || extractMeetingUrl(candidate);
}

function _extractLocationFromComponent(component) {
  const componentLocation = _firstNonEmptyString(component.get_location?.());
  if (componentLocation) return componentLocation;

  const ical = component.get_icalcomponent?.();
  return _firstNonEmptyString(_rawIcalFieldToString(ical, "get_location"));
}

function _elapsedMs(startMonotonicUs) {
  return Math.round((GLib.get_monotonic_time() - startMonotonicUs) / 1000);
}

class EdsCalendarSourceResolver {
  constructor() {
    this._registry = null;
    this._registryUnavailable = false;
    this._clientPromiseBySourceId = new Map();
  }

  stop() {
    this._registry = null;
    this._registryUnavailable = false;
    this._clientPromiseBySourceId.clear();
  }

  getKnownCalendars() {
    const calendars = new Map();
    for (const source of this._listCalendarSources())
      calendars.set(source.get_uid(), _getSourceDisplayName(source));
    return calendars;
  }

  async enrichEvents(
    events,
    sinceEpochSeconds,
    untilEpochSeconds,
    enabledCalendarIds = [],
  ) {
    const enrichStartedUs = GLib.get_monotonic_time();
    const enabledCalendarIdSet = new Set(
      (enabledCalendarIds ?? []).map((id) => String(id)),
    );
    const eventsNeedingMeetingUrl = events.filter((event) => !event.meetingUrl);
    if (eventsNeedingMeetingUrl.length === 0) {
      return {
        events,
        calendars: this.getKnownCalendars(),
      };
    }

    const sources = this._listCalendarSources();
    const calendars = new Map();
    for (const source of sources)
      calendars.set(source.get_uid(), _getSourceDisplayName(source));

    if (sources.length === 0) return { events, calendars };

    const eventsByIdKey = new Map();
    const eventsByTitleTimeKey = new Map();
    const eventsByTitleStartKey = new Map();

    for (const event of eventsNeedingMeetingUrl) {
      eventsByIdKey.set(event.id, _makeUidMatchKeys(event.id));
      eventsByTitleTimeKey.set(
        event.id,
        _makeTitleTimeMatchKey(
          event.title,
          event.startEpochSeconds,
          event.endEpochSeconds,
        ),
      );
      eventsByTitleStartKey.set(
        event.id,
        _makeTitleStartMatchKey(event.title, event.startEpochSeconds),
      );
    }

    const idMatches = new Map();
    const titleTimeMatches = new Map();
    const titleStartMatches = new Map();

    log(
      `[MeetingTime] EDS enrichment start: events=${events.length}, ` +
        `needingUrl=${eventsNeedingMeetingUrl.length}, sources=${sources.length}, ` +
        `enabledCalendars=${enabledCalendarIdSet.size}`,
    );
    const eventsToEnrich = eventsNeedingMeetingUrl.filter(
      (event) =>
        !event.sourceId ||
        enabledCalendarIdSet.size === 0 ||
        enabledCalendarIdSet.has(event.sourceId),
    );
    log(
      `[MeetingTime] EDS enrichment candidates after enabled-calendar filter: ` +
        `${eventsToEnrich.length}`,
    );
    for (const source of sources) {
      const sourceIdentity = _getSourceIdentity(source);
      const sourceEvents = eventsToEnrich.filter(
        (event) => event.sourceId === sourceIdentity.sourceId,
      );
      if (enabledCalendarIdSet.size > 0 && sourceEvents.length === 0) {
        log(
          `[MeetingTime] Skipping EDS source ${sourceIdentity.sourceName} ` +
            `(${sourceIdentity.sourceId}) because no enabled events need enrichment`,
        );
        continue;
      }

      const sourceStartedUs = GLib.get_monotonic_time();
      const client = await this._getClientForSource(source);
      if (!client) continue;

      log(
        `[MeetingTime] EDS source ready after ${_elapsedMs(sourceStartedUs)}ms: ` +
          `${sourceIdentity.sourceName} (${sourceIdentity.sourceId})`,
      );

      try {
        const collectStartedUs = GLib.get_monotonic_time();
        const components = await this._collectComponentsForSource(
          source,
          client,
          sinceEpochSeconds,
          untilEpochSeconds,
        );
        log(
          `[MeetingTime] EDS collected ${components.length} components after ` +
            `${_elapsedMs(collectStartedUs)}ms: ${sourceIdentity.sourceName} ` +
            `(${sourceIdentity.sourceId})`,
        );

        for (const component of components) {
          const componentUid = component.get_uid();
          const summary = _componentTextToString(component.get_summary?.());
          const startEpochSeconds =
            component.get_dtstart()?.get_value()?.as_timet?.() ?? 0;
          const endEpochSeconds =
            component.get_dtend()?.get_value()?.as_timet?.() ??
            startEpochSeconds;
          const uidKeys = _makeUidMatchKeys(componentUid);
          const titleTimeKey = _makeTitleTimeMatchKey(
            summary,
            startEpochSeconds,
            endEpochSeconds,
          );
          const titleStartKey = _makeTitleStartMatchKey(
            summary,
            startEpochSeconds,
          );
          const meetingUrl = _extractMeetingUrlFromComponent(component);
          const location = _extractLocationFromComponent(component);

          const candidate = {
            ...sourceIdentity,
            meetingUrl,
            location,
          };

          for (const uidKey of uidKeys)
            _recordUniqueMatch(idMatches, uidKey, candidate);
          _recordUniqueMatch(titleTimeMatches, titleTimeKey, candidate);
          _recordUniqueMatch(titleStartMatches, titleStartKey, candidate);
        }
      } catch (error) {
        logError(
          error,
          `[MeetingTime] Failed to enumerate EDS view instances for source ${source.get_uid()}`,
        );
      }
    }

    log(
      `[MeetingTime] EDS enrichment finished in ${_elapsedMs(enrichStartedUs)}ms`,
    );

    const enrichedEvents = events.map((event) => {
      const eventKeys = eventsByIdKey.get(event.id) ?? [];
      if (
        enabledCalendarIdSet.size > 0 &&
        event.sourceId &&
        !enabledCalendarIdSet.has(event.sourceId)
      )
        return event;

      const match =
        _findResolvedMatch(idMatches, eventKeys) ||
        titleTimeMatches.get(eventsByTitleTimeKey.get(event.id)) ||
        titleStartMatches.get(eventsByTitleStartKey.get(event.id));

      if (!match) return event;

      const enrichedEvent = {
        ...event,
        sourceId: event.sourceId || match.sourceId,
        sourceName: event.sourceName || match.sourceName,
        meetingUrl: event.meetingUrl || match.meetingUrl || "",
        location: event.location || match.location || "",
      };

      if (!event.meetingUrl && enrichedEvent.meetingUrl) {
        log("[MeetingTime] Enriched event URL: " + `${enrichedEvent.title}`);
      }

      return enrichedEvent;
    });

    return {
      events: enrichedEvents,
      calendars,
    };
  }

  _listCalendarSources() {
    const registry = this._ensureRegistry();
    if (!registry) return [];

    try {
      return registry
        .list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
        .filter((source) => source.get_enabled());
    } catch (error) {
      logError(error, "[MeetingTime] Failed to list EDS calendar sources");
      return [];
    }
  }

  _ensureRegistry() {
    if (this._registry) return this._registry;

    if (this._registryUnavailable) return null;

    try {
      this._registry = EDataServer.SourceRegistry.new_sync(null);
    } catch (error) {
      this._registryUnavailable = true;
      logError(error, "[MeetingTime] Failed to initialize EDS source registry");
      return null;
    }

    return this._registry;
  }

  async _getClientForSource(source) {
    const sourceId = source.get_uid();
    const startedUs = GLib.get_monotonic_time();
    if (!this._clientPromiseBySourceId.has(sourceId)) {
      const connectPromise = new Promise((resolve) => {
        ECal.Client.connect(
          source,
          ECal.ClientSourceType.EVENTS,
          EDS_CONNECT_TIMEOUT_SECONDS,
          null,
          (_source, result) => {
            try {
              resolve(ECal.Client.connect_finish(result));
            } catch (error) {
              logError(
                error,
                `[MeetingTime] Failed to connect to EDS calendar source ${sourceId}`,
              );
              resolve(null);
            }
          },
        );
      });

      this._clientPromiseBySourceId.set(sourceId, connectPromise);
    }

    const client = await this._clientPromiseBySourceId.get(sourceId);
    log(
      `[MeetingTime] EDS client connect finished in ${_elapsedMs(startedUs)}ms ` +
        `for ${sourceId}${client ? "" : " (null client)"}`,
    );
    return client;
  }

  async _collectComponentsForSource(
    source,
    client,
    sinceEpochSeconds,
    untilEpochSeconds,
  ) {
    const startedUs = GLib.get_monotonic_time();
    const filter = this._buildTimeRangeFilter(
      sinceEpochSeconds,
      untilEpochSeconds,
    );
    const components = [];
    const [ok, view] = client.get_view_sync(filter, null);

    if (!ok || !view)
      throw new Error(
        `Failed to create ECalClientView for source ${source.get_uid()}`,
      );

    return await new Promise((resolve, reject) => {
      try {
        view.connect("objects-added", (_view, objects) => {
          for (const object of objects) {
            const component = ECal.Component.new_from_icalcomponent(
              object.clone(),
            );
            if (component) components.push(component);
          }
        });

        view.connect("objects-modified", (_view, objects) => {
          for (const object of objects) {
            const component = ECal.Component.new_from_icalcomponent(
              object.clone(),
            );
            if (component) components.push(component);
          }
        });

        view.connect("complete", () => {
          resolve(components);
        });

        view.start();
      } catch (error) {
        reject(error);
      }
    }).finally(() => {
      log(
        `[MeetingTime] EDS view completed in ${_elapsedMs(startedUs)}ms ` +
          `for ${source.get_uid()}`,
      );
    });
  }

  _buildTimeRangeFilter(sinceEpochSeconds, untilEpochSeconds) {
    const since = new Date(sinceEpochSeconds * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const until = new Date(untilEpochSeconds * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    return `(occur-in-time-range? (make-time "${since}") (make-time "${until}"))`;
  }
}

function _normalizeCalendarServerEvent(rawEvent) {
  const [id, summary, startEpochSeconds, endEpochSeconds, detailsVariant] =
    rawEvent;
  const details = _deepUnpack(detailsVariant ?? {});
  const sourceContainer = _findNestedObject(details, ["source", "calendar"]);
  const derivedSourceId = _extractEventSourceId(id);

  const rawSourceId =
    _findNestedString(details, [
      "source-uid",
      "source_uid",
      "sourceuid",
      "source-id",
      "source_id",
      "sourceid",
      "calendar_uid",
      "calendar-id",
      "calendar_id",
      "calendarid",
    ]) ||
    _readDictionaryString(sourceContainer ?? {}, [
      "uid",
      "id",
      "source-uid",
      "source_uid",
      "source-id",
      "source_id",
      "calendar-uid",
      "calendar_uid",
      "calendar-id",
      "calendar_id",
    ]);

  const rawSourceName =
    _findNestedString(details, [
      "source-name",
      "source_name",
      "sourcename",
      "calendar-name",
      "calendar_name",
      "calendarname",
      "display-name",
      "display_name",
      "displayname",
    ]) ||
    _readDictionaryString(sourceContainer ?? {}, [
      "name",
      "title",
      "display-name",
      "display_name",
      "displayname",
      "source-name",
      "source_name",
      "calendar-name",
      "calendar_name",
    ]);

  const sourceName = rawSourceName || "Calendar";
  const sourceId =
    rawSourceId ||
    derivedSourceId ||
    (rawSourceName ? `calendar-name:${rawSourceName}` : "");

  const description = _readDictionaryString(details, [
    "description",
    "comment",
  ]);
  const location = _readDictionaryString(details, ["location"]);
  const url = _readDictionaryString(details, [
    "url",
    "uri",
    "meeting_url",
    "conference_url",
  ]);

  const start = Number(startEpochSeconds);
  const end = Number(endEpochSeconds);

  return {
    id: String(id),
    title: summary ? String(summary) : "Untitled event",
    startEpochSeconds: start,
    endEpochSeconds: end,
    sourceId,
    sourceName,
    description,
    location,
    url,
    isAllDay: inferAllDayEvent(start, end, details),
    backend: "calendar-server",
    calendarIdentityDebug: !sourceId
      ? _describeMissingCalendarIdentity(details)
      : null,
  };
}

class CalendarServerBackend {
  constructor() {
    this._proxy = null;
    this._signalId = 0;
    this._eventsById = new Map();
    this._onEventsChanged = null;
  }

  setEventsChangedCallback(callback) {
    this._onEventsChanged = callback;
  }

  start() {
    if (this._proxy) return;

    log("[MeetingTime] Connecting to CalendarServer");
    try {
      this._proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.NONE,
        null,
        CALENDAR_SERVER_BUS_NAME,
        CALENDAR_SERVER_OBJECT_PATH,
        CALENDAR_SERVER_INTERFACE,
        null,
      );
    } catch (error) {
      logError(
        error,
        "[MeetingTime] Failed to initialize CalendarServer D-Bus proxy",
      );
      this._proxy = null;
      return;
    }

    this._signalId = this._proxy.connect(
      "g-signal",
      (_proxy, _sender, signalName, params) => {
        if (signalName === "EventsAddedOrUpdated") {
          const [rawEvents] = _deepUnpack(params);
          this._onEventsAddedOrUpdated(rawEvents ?? []);
          return;
        }

        if (signalName === "EventsRemoved") {
          const [rawIds] = _deepUnpack(params);
          this._onEventsRemoved(rawIds ?? []);
        }
      },
    );
  }

  stop() {
    if (this._signalId && this._proxy) {
      this._proxy.disconnect(this._signalId);
      this._signalId = 0;
    }

    this._proxy = null;
    this._eventsById.clear();
    log("[MeetingTime] CalendarServer backend stopped");
  }

  async refresh(windowHours) {
    if (!this._proxy) return;

    const sinceEpochSeconds = nowEpochSeconds() - 3600;
    const untilEpochSeconds = sinceEpochSeconds + windowHours * 3600;

    if (this._onEventsChanged) {
      log(
        `[MeetingTime] Refreshing CalendarServer window: ` +
          `${sinceEpochSeconds}..${untilEpochSeconds} (${windowHours}h)`,
      );
    }
    try {
      this._proxy.call_sync(
        "SetTimeRange",
        new GLib.Variant("(xxb)", [sinceEpochSeconds, untilEpochSeconds, true]),
        Gio.DBusCallFlags.NONE,
        -1,
        null,
      );
    } catch (error) {
      logError(
        error,
        "[MeetingTime] Failed to refresh CalendarServer time range",
      );
    }
  }

  getEvents() {
    return Array.from(this._eventsById.values());
  }

  _onEventsAddedOrUpdated(rawEvents) {
    for (const rawEvent of rawEvents) {
      try {
        const event = _normalizeCalendarServerEvent(rawEvent);
        this._eventsById.set(event.id, event);
      } catch (error) {
        logError(error, "[MeetingTime] Failed to parse calendar event");
      }
    }

    this._emitEventsChanged();
  }

  _onEventsRemoved(rawIds) {
    for (const rawId of rawIds) this._eventsById.delete(String(rawId));

    this._emitEventsChanged();
  }

  _emitEventsChanged() {
    this._onEventsChanged?.(this.getEvents());
  }
}

export class CalendarBackend {
  constructor() {
    this._calendarSourceResolver = new EdsCalendarSourceResolver();
    this._calendarServer = new CalendarServerBackend();
    this._calendarServer.setEventsChangedCallback((events) => {
      void this._updateCalendarServerEvents(events);
    });

    this._calendarServerEvents = [];
    this._calendarServerCalendars = new Map();
    this._onEventsChanged = null;
    this._refreshWindowHours = 0;
    this._calendarServerUpdateToken = 0;
    this._startupSnapshot = new CalendarStartupSnapshot();
    this._restoredStartupSnapshot = null;
    this._lastEnrichedEventSignature = "";
    this._hasLiveSnapshot = false;
    this._hasCompletedInitialRefresh = false;
    this._awaitingRefreshEmission = false;
    this._enabledCalendarIds = [];
    this._started = false;
  }

  setEventsChangedCallback(callback) {
    this._onEventsChanged = callback;
  }

  start() {
    this._started = true;
    this._startupSnapshot.load((snapshot) => {
      if (!this._started || this._hasLiveSnapshot) return;

      this._restoredStartupSnapshot = snapshot;
      if (snapshot.events.length > 0) {
        log(
          `[MeetingTime] Bootstrapping calendar backend from startup snapshot: ` +
            `${snapshot.events.length} events`,
        );
        this._calendarServerEvents = snapshot.events;
        this._calendarServerCalendars = new Map();
        this._hasLiveSnapshot = true;
        this._hasCompletedInitialRefresh = true;
        this._emitCombinedEvents();
      }
    });
    this._calendarServer.start();
  }

  stop() {
    this._started = false;
    log(
      `[MeetingTime] CalendarBackend stopping with ` +
        `${this._calendarServerEvents.length} events, ${this._calendarServerCalendars.size} calendars`,
    );
    this.saveStartupSnapshot();
    this._calendarServer.stop();
    this._calendarSourceResolver.stop();
    this._calendarServerEvents = [];
    this._calendarServerCalendars = new Map();
    this._restoredStartupSnapshot = null;
  }

  saveStartupSnapshot() {
    const liveEvents = this._calendarServerEvents;
    const fallback = this._restoredStartupSnapshot;

    if (Array.isArray(liveEvents) && liveEvents.length > 0) {
      log("[MeetingTime] Saving live startup snapshot state");
      this._startupSnapshot.save(liveEvents);
      return;
    }

    if (
      fallback &&
      Array.isArray(fallback.events) &&
      fallback.events.length > 0
    ) {
      log(
        "[MeetingTime] Saving restored startup snapshot as shutdown fallback",
      );
      this._startupSnapshot.save(fallback.events);
      return;
    }

    log("[MeetingTime] Saving empty startup snapshot state");
    this._startupSnapshot.save(liveEvents);
  }

  clearStartupSnapshot() {
    log("[MeetingTime] Clearing startup snapshot state");
    this._startupSnapshot.clear();
  }

  async refresh(windowHours, enabledCalendarIds = []) {
    this._refreshWindowHours = windowHours;
    this._enabledCalendarIds = Array.from(
      new Set((enabledCalendarIds ?? []).map((id) => String(id))),
    );
    this._awaitingRefreshEmission = true;
    if (this._onEventsChanged)
      log(`[MeetingTime] Refresh requested for ${windowHours}h window`);
    await this._calendarServer.refresh(windowHours);
    this._calendarServerCalendars =
      this._calendarSourceResolver.getKnownCalendars();

    this._emitCombinedEvents();
  }

  async _updateCalendarServerEvents(events) {
    if (
      events.length === 0 &&
      !this._hasLiveSnapshot &&
      this._calendarServerEvents.length > 0
    )
      return;

    const signature = _serializeEventSignature(events);
    if (signature === this._lastEnrichedEventSignature) return;

    this._lastEnrichedEventSignature = signature;

    const updateToken = ++this._calendarServerUpdateToken;
    const sinceEpochSeconds = nowEpochSeconds() - 3600;
    const untilEpochSeconds =
      sinceEpochSeconds + this._refreshWindowHours * 3600;

    if (this._onEventsChanged)
      log(`[MeetingTime] Enriching ${events.length} CalendarServer events`);

    try {
      const enriched = await this._calendarSourceResolver.enrichEvents(
        events,
        sinceEpochSeconds,
        untilEpochSeconds,
        this._enabledCalendarIds,
      );

      if (updateToken !== this._calendarServerUpdateToken) return;

      this._calendarServerEvents = enriched.events;
      this._calendarServerCalendars = enriched.calendars;
      this._hasLiveSnapshot = true;

      _logEventList(
        "CalendarServer enriched events",
        this._calendarServerEvents,
      );

      for (const event of this._calendarServerEvents) {
        if (!event.sourceId) _logMissingCalendarIdentity(event);
      }

      this.saveStartupSnapshot();
      this._emitCombinedEvents();
    } catch (error) {
      logError(
        error,
        "[MeetingTime] Failed to enrich CalendarServer events with EDS source metadata",
      );

      if (updateToken !== this._calendarServerUpdateToken) return;

      this._calendarServerEvents = events;
      this._calendarServerCalendars =
        this._calendarSourceResolver.getKnownCalendars();
      this._hasLiveSnapshot = true;

      _logEventList(
        "CalendarServer fallback events",
        this._calendarServerEvents,
      );

      for (const event of this._calendarServerEvents) {
        if (!event.sourceId) _logMissingCalendarIdentity(event);
      }

      this.saveStartupSnapshot();
      this._emitCombinedEvents();
    }
  }

  _emitCombinedEvents() {
    if (this._awaitingRefreshEmission) {
      this._hasCompletedInitialRefresh = true;
      this._awaitingRefreshEmission = false;
    }

    const merged = [...this._calendarServerEvents].sort(
      (a, b) => a.startEpochSeconds - b.startEpochSeconds,
    );

    if (this._onEventsChanged) {
      log(
        `[MeetingTime] Emitting combined events: ${merged.length} events, ` +
          `${this._calendarServerCalendars.size} calendars`,
      );
    }
    _logEventList("CalendarServer merged events", merged);
    this.saveStartupSnapshot();

    const calendars = new Map(this._calendarServerCalendars);
    for (const event of merged) {
      if (!event.sourceId) continue;
      if (!calendars.has(event.sourceId))
        calendars.set(event.sourceId, event.sourceName || event.sourceId);
    }

    this._onEventsChanged?.(merged, calendars, {
      hasCompletedInitialRefresh: this._hasCompletedInitialRefresh,
    });
  }
}
