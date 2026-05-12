// Shared startup snapshot for MeetingTime runtime state.
//
// This file stores the latest normalized event snapshot and known calendar
// metadata used to restore runtime state quickly on startup. It is the only
// persisted snapshot file used by the extension.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const SNAPSHOT_DIR_NAME = "meetingtime";
const SNAPSHOT_FILE_NAME = "calendar-snapshot.json";

function _serializeSnapshotState(events) {
  return {
    savedAtEpochSeconds: Math.floor(Date.now() / 1000),
    events,
  };
}

function _deserializeSnapshotState(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      savedAtEpochSeconds: Number(parsed.savedAtEpochSeconds ?? 0),
    };
  } catch (_error) {
    return null;
  }
}

function _summarizeSnapshot(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const firstSummary = firstEvent
    ? `${firstEvent.startEpochSeconds ?? "?"}:${firstEvent.title ?? "(untitled)"}`
    : "none";
  const lastSummary = lastEvent
    ? `${lastEvent.startEpochSeconds ?? "?"}:${lastEvent.title ?? "(untitled)"}`
    : "none";

  return `events=${events.length}, first=${firstSummary}, last=${lastSummary}`;
}

export class CalendarStartupSnapshot {
  constructor() {
    this._snapshotDir = GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      SNAPSHOT_DIR_NAME,
    ]);
    this._snapshotFile = GLib.build_filenamev([
      this._snapshotDir,
      SNAPSHOT_FILE_NAME,
    ]);
    this._snapshotDirFile = Gio.File.new_for_path(this._snapshotDir);
    this._snapshotGFile = Gio.File.new_for_path(this._snapshotFile);
  }

  load(callback) {
    log(
      `[MeetingTime] Attempting to restore startup snapshot from ${this._snapshotFile}`,
    );

    this._snapshotGFile.load_contents_async(null, (file, result) => {
      let snapshotResult = { events: [] };
      try {
        const [ok, contents] = file.load_contents_finish(result);
        if (!ok) {
          callback(snapshotResult);
          return;
        }

        const snapshot = _deserializeSnapshotState(
          imports.byteArray.toString(contents),
        );
        if (!snapshot) {
          callback(snapshotResult);
          return;
        }

        log(
          `[MeetingTime] Restored startup snapshot from ${this._snapshotFile}: ${_summarizeSnapshot(snapshot)}`,
        );
        snapshotResult = {
          events: snapshot.events,
        };
      } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
          log(
            `[MeetingTime] No startup snapshot found at ${this._snapshotFile}`,
          );
        else
          logError(
            error,
            "[MeetingTime] Failed to load startup snapshot state",
          );
      }

      callback(snapshotResult);
    });
  }

  _writeSnapshot(events) {
    const snapshot = {
      events,
    };
    log(
      `[MeetingTime] Creating startup snapshot at ${this._snapshotFile}: ${_summarizeSnapshot(snapshot)}`,
    );
    const payload = imports.byteArray.fromString(
      JSON.stringify(_serializeSnapshotState(events)),
    );
    this._snapshotGFile.replace_contents_async(
      payload,
      null,
      false,
      Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
      (_file, result) => {
        try {
          this._snapshotGFile.replace_contents_finish(result);
        } catch (error) {
          logError(
            error,
            "[MeetingTime] Failed to save startup snapshot state",
          );
        }
      },
    );
  }

  save(events) {
    if (!Array.isArray(events) || events.length === 0) {
      log("[MeetingTime] Skipping startup snapshot save: no events to persist");
      return;
    }

    this._snapshotDirFile.make_directory_async(
      GLib.PRIORITY_DEFAULT,
      null,
      (dirFile, result) => {
        try {
          dirFile.make_directory_finish(result);
        } catch (error) {
          if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
            logError(
              error,
              "[MeetingTime] Failed to create startup snapshot directory",
            );
            return;
          }
        }

        this._writeSnapshot(events);
      },
    );
  }

  getFilePath() {
    return this._snapshotFile;
  }

  clear() {
    this._snapshotGFile.delete_async(
      GLib.PRIORITY_DEFAULT,
      null,
      (file, result) => {
        try {
          file.delete_finish(result);
        } catch (error) {
          if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            logError(
              error,
              "[MeetingTime] Failed to clear startup snapshot state",
            );
        }
      },
    );
  }
}
