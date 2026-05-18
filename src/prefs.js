import Adw from "gi://Adw";
import EDataServer from "gi://EDataServer?version=1.2";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gst from "gi://Gst";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { DEFAULT_ALERT_SOUND_FILENAME, NO_EVENTS_LABELS } from "./lib/util.js";

function _extensionRoot() {
  return GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
}

function _soundDir() {
  return GLib.build_filenamev([_extensionRoot(), "sounds"]);
}

function _soundPath(filename) {
  return GLib.build_filenamev([_soundDir(), filename]);
}

function _loadExtensionMetadata() {
  try {
    const metadataPath = GLib.build_filenamev([_extensionRoot(), "metadata.json"]);
    const file = Gio.File.new_for_path(metadataPath);
    const [ok, contents] = file.load_contents(null);
    if (!ok) return {};

    return JSON.parse(imports.byteArray.toString(contents));
  } catch (error) {
    logError(error, "[MeetingTime] Failed to load extension metadata");
    return {};
  }
}

function _loadSoundOptions() {
  const options = [
    {
      filename: "",
      label: "(no sound)",
    },
  ];
  try {
    const dir = Gio.File.new_for_path(_soundDir());
    const enumerator = dir.enumerate_children(
      "standard::name,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      null,
    );

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
      if (info.get_file_type() !== Gio.FileType.REGULAR) continue;

      const name = info.get_name();
      if (!name.match(/\.(mp3|ogg|wav)$/i)) continue;

      options.push({
        filename: name,
        label: name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
      });
    }

    options.sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.filename.localeCompare(b.filename),
    );

    const defaultIndex = options.findIndex(
      (option) => option.filename === DEFAULT_ALERT_SOUND_FILENAME,
    );
    if (defaultIndex > 0) {
      const [defaultOption] = options.splice(defaultIndex, 1);
      options.splice(1, 0, defaultOption);
    }
  } catch (error) {
    logError(error, "[MeetingTime] Failed to load alert sounds");
  }

  return options;
}

function _playSoundPreview(filename) {
  try {
    if (!Gst.is_initialized()) Gst.init(null);

    const soundName =
      String(filename ?? "").trim() || DEFAULT_ALERT_SOUND_FILENAME;
    const soundPath = _soundPath(soundName);
    const pipeline = Gst.ElementFactory.make(
      "playbin",
      "meetingtime-preview-sound",
    );
    if (!pipeline) return;

    const uri = Gio.File.new_for_path(soundPath).get_uri();
    pipeline.set_property("uri", uri);
    pipeline.set_state(Gst.State.PLAYING);
  } catch (error) {
    logError(error, "[MeetingTime] Failed to preview alert sound");
  }
}

function _loadKnownCalendarSources() {
  const calendars = new Map();

  try {
    const registry = EDataServer.SourceRegistry.new_sync(null);
    const sources = registry
      .list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
      .filter((source) => source.get_enabled());

    for (const source of sources) {
      const id = source.get_uid();
      if (!id) continue;

      calendars.set(id, {
        id,
        name: source.get_display_name() || "Calendar",
        subtitle: "",
      });
    }
  } catch (error) {
    logError(
      error,
      "[MeetingTime] Failed to load calendar sources for preferences",
    );
  }

  const nameCounts = new Map();
  for (const calendar of calendars.values())
    nameCounts.set(calendar.name, (nameCounts.get(calendar.name) ?? 0) + 1);

  return Array.from(calendars.values())
    .map((calendar) => ({
      ...calendar,
      subtitle:
        calendar.subtitle ||
        (nameCounts.get(calendar.name) > 1 ? calendar.id : ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function _formatCalendarSelectionSummary(knownCalendars, enabledIds) {
  if (knownCalendars.length === 0) {
    if (enabledIds.length === 0)
      return "No calendar sources detected, and none are enabled.";

    return `${enabledIds.length} saved source UID(s) enabled, but none are currently available.`;
  }

  if (enabledIds.length === 0) {
    return "No calendar sources enabled.";
  }

  const knownIds = new Set(knownCalendars.map((calendar) => calendar.id));
  const enabledKnownCount = knownCalendars.filter((calendar) =>
    enabledIds.includes(calendar.id),
  ).length;
  const unavailableCount = enabledIds.filter((id) => !knownIds.has(id)).length;

  let summary = `${enabledKnownCount} of ${knownCalendars.length} calendar source${knownCalendars.length === 1 ? "" : "s"} enabled.`;
  if (unavailableCount > 0) {
    summary += ` ${unavailableCount} unavailable source${unavailableCount === 1 ? "" : "s"} still selected.`;
  }

  return summary;
}

const PANEL_POSITION_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

function _syncStringDropDown(
  settings,
  key,
  values,
  dropdown,
  defaultIndex = 0,
) {
  const fallbackIndex = defaultIndex >= 0 ? defaultIndex : 0;
  const sync = () => {
    const selected = settings.get_string(key);
    const selectedIndex = values.indexOf(selected);
    const effectiveIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
    const effectiveValue =
      values[effectiveIndex] ?? values[fallbackIndex] ?? "";

    dropdown.set_selected(effectiveIndex);
    if (selected !== effectiveValue) settings.set_string(key, effectiveValue);
  };

  sync();
  dropdown.connect("notify::selected", (widget) => {
    const index = widget.get_selected();
    const value = values[index] ?? values[fallbackIndex] ?? "";
    if (settings.get_string(key) !== value) settings.set_string(key, value);
  });
  settings.connect(`changed::${key}`, sync);
}

export default class MeetingTimePreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    window.set_title("MeetingTime Settings");
    window.set_default_size(680, 560);

    const calendarsPage = new Adw.PreferencesPage({
      title: "Calendars",
      icon_name: "x-office-calendar-symbolic",
    });
    window.add(calendarsPage);

    const generalPage = new Adw.PreferencesPage({
      title: "Alerts",
      icon_name: "alarm-symbolic",
    });
    window.add(generalPage);

    const advancedPage = new Adw.PreferencesPage({
      title: "Advanced",
      icon_name: "emblem-system-symbolic",
    });
    window.add(advancedPage);

    const aboutPage = new Adw.PreferencesPage({
      title: "About",
      icon_name: "help-about-symbolic",
    });
    window.add(aboutPage);

    const generalGroup = new Adw.PreferencesGroup({
      title: "General",
      description: "Core scheduling and alert behavior.",
    });
    generalPage.add(generalGroup);

    const enabledRow = new Adw.SwitchRow({
      title: "Enable alerts",
      subtitle: "Show full-screen alerts before events.",
    });
    generalGroup.add(enabledRow);

    const excludeAllDayRow = new Adw.SwitchRow({
      title: "Exclude all-day events",
      subtitle: "Ignore all-day events when deciding which alerts to show.",
    });
    generalGroup.add(excludeAllDayRow);

    const panelPositionLabels = new Gtk.StringList();
    const panelPositionValues = [];
    for (const option of PANEL_POSITION_OPTIONS) {
      panelPositionValues.push(option.value);
      panelPositionLabels.append(option.label);
    }

    const panelPositionRow = new Adw.ActionRow({
      title: "Indicator position",
      subtitle: "Choose where the top-panel indicator appears.",
    });
    const panelPositionDropDown = new Gtk.DropDown({
      model: panelPositionLabels,
      valign: Gtk.Align.CENTER,
    });
    panelPositionRow.add_suffix(panelPositionDropDown);
    panelPositionRow.activatable_widget = panelPositionDropDown;
    generalGroup.add(panelPositionRow);
    _syncStringDropDown(
      settings,
      "panel-position",
      panelPositionValues,
      panelPositionDropDown,
      panelPositionValues.indexOf("right"),
    );

    const alertLeadRow = new Adw.SpinRow({
      title: "Alert lead time",
      subtitle: "Minutes before start time to show the alert.",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 60,
        step_increment: 1,
        page_increment: 5,
      }),
    });
    generalGroup.add(alertLeadRow);

    const snoozeRow = new Adw.SpinRow({
      title: "Default snooze",
      subtitle: "Minutes to delay when clicking snooze.",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 60,
        step_increment: 1,
        page_increment: 5,
      }),
    });
    generalGroup.add(snoozeRow);

    const soundOptions = _loadSoundOptions();
    const soundLabels = new Gtk.StringList();
    const soundNames = [];
    for (const option of soundOptions) {
      soundNames.push(option.filename);
      soundLabels.append(option.label);
    }

    const soundFileRow = new Adw.ActionRow({
      title: "Alert sound",
      subtitle: "Choose which bundled sound to play when an alert appears.",
    });
    const soundDropDown = new Gtk.DropDown({
      model: soundLabels,
      valign: Gtk.Align.CENTER,
    });
    soundFileRow.add_suffix(soundDropDown);
    soundFileRow.activatable_widget = soundDropDown;
    generalGroup.add(soundFileRow);

    const soundPreviewButton = new Gtk.Button({
      label: "Preview",
      icon_name: "audio-volume-high-symbolic",
      valign: Gtk.Align.CENTER,
    });
    soundPreviewButton.add_css_class("flat");
    soundFileRow.add_suffix(soundPreviewButton);

    const advancedGroup = new Adw.PreferencesGroup({
      title: "Advanced",
      description: "Low-level tuning and diagnostics.",
    });
    advancedPage.add(advancedGroup);

    const alertHorizonWindowRow = new Adw.SpinRow({
      title: "Alert Horizon",
      subtitle: "How many hours ahead to track events",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 72,
        step_increment: 1,
        page_increment: 6,
      }),
    });
    advancedGroup.add(alertHorizonWindowRow);

    const refreshIntervalRow = new Adw.SpinRow({
      title: "Refresh interval",
      subtitle: "How often to reload calendar data.",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 60,
        step_increment: 1,
        page_increment: 5,
      }),
    });
    advancedGroup.add(refreshIntervalRow);

    const clearCacheRow = new Adw.ActionRow({
      title: "Clear cache",
      subtitle: "Delete the startup snapshot so the next launch starts clean.",
    });
    clearCacheRow.activatable = false;
    const clearCacheButton = new Gtk.Button({
      label: "Clear cache",
      valign: Gtk.Align.CENTER,
    });
    clearCacheButton.add_css_class("flat");
    clearCacheButton.connect("clicked", () => {
      const snapshotFile = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        "meetingtime",
        "calendar-snapshot.json",
      ]);

      try {
        if (GLib.file_test(snapshotFile, GLib.FileTest.EXISTS)) {
          GLib.unlink(snapshotFile);
          log(`[MeetingTime] Cleared startup snapshot at ${snapshotFile}`);
        } else {
          log(`[MeetingTime] No startup snapshot to clear at ${snapshotFile}`);
        }
      } catch (error) {
        logError(
          error,
          "[MeetingTime] Failed to clear startup snapshot from preferences",
        );
      }
    });
    clearCacheRow.add_suffix(clearCacheButton);
    advancedGroup.add(clearCacheRow);

    const forceSyncRow = new Adw.ActionRow({
      title: "Force sync",
      subtitle: "Request an immediate refresh of calendar data.",
    });
    forceSyncRow.activatable = false;
    const forceSyncButton = new Gtk.Button({
      label: "Force sync",
      valign: Gtk.Align.CENTER,
    });
    forceSyncButton.add_css_class("flat");
    forceSyncButton.connect("clicked", () => {
      settings.set_string(
        "force-refresh-request",
        `${Date.now()}-${GLib.uuid_string_random()}`,
      );
      log(
        "[MeetingTime] User requested an immediate calendar sync from preferences",
      );
    });
    forceSyncRow.add_suffix(forceSyncButton);
    advancedGroup.add(forceSyncRow);

    const calendarsGroup = new Adw.PreferencesGroup({
      title: "Calendar Sources",
      description: "Choose which calendars will trigger a full-screen alert",
    });
    calendarsPage.add(calendarsGroup);

    const knownCalendars = _loadKnownCalendarSources();
    const allKnownCalendarIds = knownCalendars.map((calendar) => calendar.id);
    const unavailableEnabledIds = settings
      .get_strv("enabled-calendar-uids")
      .filter((id) => !allKnownCalendarIds.includes(id))
      .sort();
    const calendarRows = new Map();
    let syncingCalendarRows = false;
    const getEnabledIds = () =>
      new Set(settings.get_strv("enabled-calendar-uids"));
    const setEnabledIds = (enabledIds) => {
      settings.set_strv(
        "enabled-calendar-uids",
        Array.from(
          new Set(
            enabledIds
              .map((id) => String(id).trim())
              .filter((id) => id.length > 0),
          ),
        ).sort(),
      );
    };

    const calendarSummaryRow = new Adw.ActionRow({
      title: "Alerted calendars",
      subtitle: _formatCalendarSelectionSummary(
        knownCalendars,
        settings.get_strv("enabled-calendar-uids"),
      ),
    });
    const enableAllCalendarsButton = new Gtk.Button({
      label: "All",
      valign: Gtk.Align.CENTER,
    });
    enableAllCalendarsButton.add_css_class("flat");
    enableAllCalendarsButton.connect("clicked", () => {
      log("[MeetingTime] User enabled all calendars as alert sources");
      setEnabledIds([...allKnownCalendarIds, ...unavailableEnabledIds]);
      syncCalendarRows();
    });
    calendarSummaryRow.add_suffix(enableAllCalendarsButton);

    const disableAllCalendarsButton = new Gtk.Button({
      label: "None",
      valign: Gtk.Align.CENTER,
    });
    disableAllCalendarsButton.add_css_class("flat");
    disableAllCalendarsButton.connect("clicked", () => {
      log("[MeetingTime] User disabled all calendars as alert sources");
      setEnabledIds([]);
      syncCalendarRows();
    });
    calendarSummaryRow.add_suffix(disableAllCalendarsButton);
    calendarsGroup.add(calendarSummaryRow);

    const syncCalendarRows = () => {
      const enabledIds = settings.get_strv("enabled-calendar-uids");
      const enabledSet = getEnabledIds();

      calendarSummaryRow.set_subtitle(
        _formatCalendarSelectionSummary(knownCalendars, enabledIds),
      );
      enableAllCalendarsButton.set_sensitive(
        calendarRows.size > 0 &&
          Array.from(calendarRows.keys()).some((id) => !enabledSet.has(id)),
      );
      disableAllCalendarsButton.set_sensitive(enabledIds.length > 0);

      syncingCalendarRows = true;
      for (const [calendarId, row] of calendarRows.entries()) {
        row.set_active(enabledSet.has(calendarId));
      }
      syncingCalendarRows = false;
    };

    if (knownCalendars.length === 0 && unavailableEnabledIds.length === 0) {
      calendarsGroup.add(
        new Adw.ActionRow({
          title: "No calendar sources detected",
          subtitle: "Reopen settings after GNOME calendars become available.",
          sensitive: false,
        }),
      );
    } else {
      for (const calendar of knownCalendars) {
        const row = new Adw.SwitchRow({
          title: calendar.name,
          active: getEnabledIds().has(calendar.id),
        });
        if (calendar.subtitle) row.set_subtitle(calendar.subtitle);

        row.connect("notify::active", (widget) => {
          if (syncingCalendarRows) return;

          const enabledIds = new Set(
            settings.get_strv("enabled-calendar-uids"),
          );
          if (widget.get_active()) {
            enabledIds.add(calendar.id);
            log(
              `[MeetingTime] User enabled calendar "${calendar.name}" as an alert source (${calendar.id})`,
            );
          } else {
            enabledIds.delete(calendar.id);
            log(
              `[MeetingTime] User disabled calendar "${calendar.name}" as an alert source (${calendar.id})`,
            );
          }
          setEnabledIds(Array.from(enabledIds));
          syncCalendarRows();
        });

        calendarRows.set(calendar.id, row);
        calendarsGroup.add(row);
      }

      for (const calendarId of unavailableEnabledIds) {
        const row = new Adw.SwitchRow({
          title: calendarId,
          subtitle: "Saved source UID is not currently available.",
          active: getEnabledIds().has(calendarId),
        });

        row.connect("notify::active", (widget) => {
          if (syncingCalendarRows) return;

          const enabledIds = new Set(
            settings.get_strv("enabled-calendar-uids"),
          );
          if (widget.get_active()) {
            enabledIds.add(calendarId);
            log(
              `[MeetingTime] User enabled calendar "${calendarId}" as an alert source`,
            );
          } else {
            enabledIds.delete(calendarId);
            log(
              `[MeetingTime] User disabled calendar "${calendarId}" as an alert source`,
            );
          }
          setEnabledIds(Array.from(enabledIds));
          syncCalendarRows();
        });

        calendarRows.set(calendarId, row);
        calendarsGroup.add(row);
      }
    }

    syncCalendarRows();

    settings.bind(
      "enabled",
      enabledRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      "alert-minutes-before",
      alertLeadRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      "default-snooze-minutes",
      snoozeRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      "exclude-all-day-events",
      excludeAllDayRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      "alert-horizon-hours",
      alertHorizonWindowRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settings.bind(
      "refresh-interval-minutes",
      refreshIntervalRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    _syncStringDropDown(
      settings,
      "panel-position",
      panelPositionValues,
      panelPositionDropDown,
      panelPositionValues.indexOf("right"),
    );

    const updateSoundFileLabel = () => {
      const selected = settings.get_string("alert-sound-file");
      const selectedIndex = soundNames.indexOf(selected);
      const effectiveIndex =
        selectedIndex >= 0
          ? selectedIndex
          : soundNames.indexOf(DEFAULT_ALERT_SOUND_FILENAME) >= 0
            ? soundNames.indexOf(DEFAULT_ALERT_SOUND_FILENAME)
            : soundOptions.length > 1
              ? 1
              : soundOptions.length > 0
                ? 0
                : -1;

      if (effectiveIndex >= 0) {
        soundDropDown.set_selected(effectiveIndex);
        const effectiveFilename = soundNames[effectiveIndex] ?? "";
        if (selected !== effectiveFilename)
          settings.set_string("alert-sound-file", effectiveFilename);
      }

      const label =
        soundOptions.find(
          (option) => option.filename === soundNames[effectiveIndex],
        )?.label ??
        soundOptions[0]?.label ??
        "Bundled sound";
      soundFileRow.set_subtitle(`Selected: ${label}`);
      soundPreviewButton.set_sensitive(
        (soundNames[effectiveIndex] ?? "") !== "",
      );
    };

    updateSoundFileLabel();

    soundDropDown.connect("notify::selected", (widget) => {
      const index = widget.get_selected();
      const filename = soundNames[index] ?? "";
      settings.set_string("alert-sound-file", filename);
      updateSoundFileLabel();

      if (filename) _playSoundPreview(filename);
    });

    soundPreviewButton.connect("clicked", () => {
      const selected = settings.get_string("alert-sound-file");
      const effective = soundNames.includes(selected)
        ? selected
        : soundNames.includes(DEFAULT_ALERT_SOUND_FILENAME)
          ? DEFAULT_ALERT_SOUND_FILENAME
          : soundNames.length > 1
            ? soundNames[1]
            : (soundNames[0] ?? "");
      if (effective) _playSoundPreview(effective);
    });

    settings.connect("changed::alert-sound-file", () => updateSoundFileLabel());

    const noEventsLabels = new Gtk.StringList();
    for (const label of NO_EVENTS_LABELS) noEventsLabels.append(label);

    const noEventsRow = new Adw.ActionRow({
      title: "No events label",
      subtitle: "Choose the text shown when no upcoming events are available.",
    });
    const noEventsDropDown = new Gtk.DropDown({
      model: noEventsLabels,
      valign: Gtk.Align.CENTER,
    });
    noEventsRow.add_suffix(noEventsDropDown);
    noEventsRow.activatable_widget = noEventsDropDown;
    advancedGroup.add(noEventsRow);
    _syncStringDropDown(
      settings,
      "no-events-label",
      NO_EVENTS_LABELS,
      noEventsDropDown,
    );

    const metadata = _loadExtensionMetadata();
    const aboutGroup = new Adw.PreferencesGroup({
      title: metadata.name ?? "MeetingTime",
      description: metadata.description ?? "",
    });
    aboutPage.add(aboutGroup);

    aboutGroup.add(
      new Adw.ActionRow({
        title: "Version",
        subtitle: String(metadata.version ?? "Unknown"),
      }),
    );

    aboutGroup.add(
      new Adw.ActionRow({
        title: "Extension UUID",
        subtitle: metadata.uuid ?? "meetingtime@danmoz",
      }),
    );

    const shellVersions = metadata["shell-version"] ?? [];
    aboutGroup.add(
      new Adw.ActionRow({
        title: "GNOME Shell compatibility",
        subtitle:
          shellVersions.length > 0 ? shellVersions.join(", ") : "Unknown",
      }),
    );

    if (metadata.url) {
      const projectRow = new Adw.ActionRow({
        title: "Project page",
        subtitle: metadata.url,
      });
      const projectButton = new Gtk.LinkButton({
        label: "Open",
        uri: metadata.url,
        valign: Gtk.Align.CENTER,
      });
      projectButton.add_css_class("flat");
      projectRow.add_suffix(projectButton);
      projectRow.activatable_widget = projectButton;
      aboutGroup.add(projectRow);
    }
  }
}
