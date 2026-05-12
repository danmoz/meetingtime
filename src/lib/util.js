import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gst from "gi://Gst";

const ALERT_SOUND_DIR = GLib.build_filenamev([
  GLib.path_get_dirname(
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
  ),
  "sounds",
]);
export const DEFAULT_ALERT_SOUND_FILENAME = "Notification.ogg";
export const NO_EVENTS_LABELS = [
  "All clear",
  "Event-free",
  "No events",
  "Coast is clear",
  "Peaceful sailing",
  "Sweet freedom",
  "Untethered",
  "(random)",
];
const DEFAULT_ALERT_SOUND_FILE = GLib.build_filenamev([
  ALERT_SOUND_DIR,
  DEFAULT_ALERT_SOUND_FILENAME,
]);

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const VIDEO_HOST_REGEX =
  /(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com|jitsi|chime\.aws|around\.co)/i;
const GOOGLE_DELIMITER =
  "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-";

function _toLower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function _cleanUrl(url) {
  return (url ?? "").replace(/[),.;!?]+$/, "");
}

function _extractGoogleSection(description) {
  // Adapted from GNOME Calendar's Google description parsing.
  const text = String(description ?? "");
  if (!text) return "";

  const firstDelimiter = text.indexOf(GOOGLE_DELIMITER);
  if (firstDelimiter < 0) return "";

  const start = firstDelimiter + GOOGLE_DELIMITER.length;
  const lastDelimiter = text.indexOf(GOOGLE_DELIMITER, start);
  if (lastDelimiter < 0) return "";

  return text.slice(start, lastDelimiter);
}

function _extractPreferredUrl(text) {
  const matches = String(text ?? "").match(URL_REGEX) ?? [];
  if (matches.length === 0) return "";

  const urls = matches.map(_cleanUrl);
  const preferred = urls.find((url) => VIDEO_HOST_REGEX.test(_toLower(url)));
  return preferred ?? urls[0];
}

let _alertSoundPipeline = null;

function _stopAlertSound() {
  if (!_alertSoundPipeline) return;

  _alertSoundPipeline.set_state(Gst.State.NULL);
  _alertSoundPipeline = null;
}

function _resolveSoundPath(path) {
  const soundPath = String(path ?? "").trim();
  if (!soundPath) return DEFAULT_ALERT_SOUND_FILE;

  if (GLib.path_is_absolute(soundPath)) return soundPath;

  return GLib.build_filenamev([ALERT_SOUND_DIR, soundPath]);
}

function _soundFileExists(path) {
  try {
    return Gio.File.new_for_path(path).query_exists(null);
  } catch (_error) {
    return false;
  }
}

function _buildSoundUri(path) {
  const resolved = _resolveSoundPath(path);
  try {
    return GLib.filename_to_uri(resolved, null);
  } catch (_error) {
    return "";
  }
}

export function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function openUri(uri) {
  if (!uri) return;

  try {
    Gio.AppInfo.launch_default_for_uri(uri, null);
  } catch (error) {
    logError(error, `[MeetingTime] Failed to open URI: ${uri}`);
  }
}

export function openDefaultCalendar() {
  try {
    const desktopFileNames = [
      "org.gnome.Calendar.desktop",
      "evolution-calendar.desktop",
    ];

    for (const desktopFileName of desktopFileNames) {
      const appInfo = Gio.DesktopAppInfo.new(desktopFileName);
      if (!appInfo) continue;

      appInfo.launch([], null);
      return true;
    }
  } catch (error) {
    logError(error, "[MeetingTime] Failed to open default calendar");
  }

  return false;
}

export function maybePlayAlertSound(soundFile = "") {
  const selectedSound = String(soundFile ?? "").trim();
  if (!selectedSound) return;

  try {
    if (!Gst.is_initialized()) Gst.init(null);

    const alertSoundUri = _buildSoundUri(selectedSound);
    if (!alertSoundUri || !_soundFileExists(_resolveSoundPath(selectedSound)))
      return;

    _stopAlertSound();

    const pipeline = Gst.ElementFactory.make(
      "playbin",
      "meetingtime-alert-sound",
    );
    if (!pipeline || !alertSoundUri) return;

    pipeline.set_property("uri", alertSoundUri);
    const bus = pipeline.get_bus();
    bus.add_signal_watch();
    bus.connect("message", (_bus, message) => {
      const type = message.type;
      if (type === Gst.MessageType.EOS || type === Gst.MessageType.ERROR)
        _stopAlertSound();
    });

    _alertSoundPipeline = pipeline;
    pipeline.set_state(Gst.State.PLAYING);
  } catch (_error) {
    // Ignore: alerts are still shown visually.
  }
}

export function extractMeetingUrl(event) {
  const candidates = [];

  if (event.meetingUrl) candidates.push(event.meetingUrl);

  if (event.url) candidates.push(event.url);

  if (event.location) candidates.push(event.location);

  if (event.description) candidates.push(event.description);

  for (const text of candidates) {
    const directUrl = _extractPreferredUrl(text);
    if (directUrl) return directUrl;

    const googleSection = _extractGoogleSection(text);
    if (googleSection) {
      const googleUrl = _extractPreferredUrl(googleSection);
      if (googleUrl) return googleUrl;
    }
  }

  return "";
}

export function extractGoogleMeetingUrl(description) {
  const googleSection = _extractGoogleSection(description);
  if (!googleSection) return "";

  return _extractPreferredUrl(googleSection);
}

export function formatRelativeTime(
  targetEpochSeconds,
  referenceEpochSeconds = nowEpochSeconds(),
) {
  const deltaSeconds = targetEpochSeconds - referenceEpochSeconds;
  const absSeconds = Math.abs(deltaSeconds);
  const isFuture = deltaSeconds >= 0;

  if (absSeconds < 3600) {
    const minutes = Math.max(1, Math.round(absSeconds / 60));
    return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
  }

  if (absSeconds < 86400) {
    const hours = Math.max(1, Math.round(absSeconds / 3600));
    return isFuture ? `in ${hours}h` : `${hours}h ago`;
  }

  const days = Math.max(1, Math.round(absSeconds / 86400));
  return isFuture ? `in ${days}d` : `${days}d ago`;
}

export function formatClock(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatWeekday(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleDateString([], {
    weekday: "long",
  });
}

export function formatEventTimeRange(event) {
  const start = formatClock(event.startEpochSeconds);
  const end = formatClock(event.endEpochSeconds);
  return `${start} - ${end}`;
}
