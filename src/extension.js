import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { CalendarBackend } from "./lib/calendarBackend.js";
import { MeetingIndicator } from "./lib/indicator.js";
import { MeetingOverlay } from "./lib/overlay.js";
import { MeetingScheduler } from "./lib/scheduler.js";

export default class MeetingTimeExtension extends Extension {
  enable() {
    log("[MeetingTime] Enabling extension");
    this._settings = this.getSettings();
    this._positionSignalId = 0;

    this._backend = new CalendarBackend();
    this._overlay = new MeetingOverlay(this._settings);
    this._scheduler = new MeetingScheduler(
      this._settings,
      this._backend,
      this._overlay,
    );
    this._indicator = new MeetingIndicator(this._settings, {
      onJoinEvent: (eventId) => this._scheduler.openEvent(eventId),
      onShowEventAlert: (eventId) => this._scheduler.showAlertForEvent(eventId),
      onOpenPrefs: () =>
        Main.extensionManager.openExtensionPrefs?.(this.uuid, "", {}),
      onRefresh: () => this._scheduler.forceRefresh(),
      onClearCache: () => this._backend.clearStartupSnapshot(),
    });

    this._scheduler.setEventsChangedCallback((events, _calendars, status) => {
      this._indicator.setStatus(status);
      this._indicator.setEvents(events);
    });

    this._placeIndicator();
    this._positionSignalId = this._settings.connect(
      "changed::panel-position",
      () => {
        this._placeIndicator();
      },
    );
    this._scheduler.start();

    log("[MeetingTime] Extension enabled");
  }

  _placeIndicator() {
    if (!this._indicator || !this._settings) return;

    const position = this._settings.get_string("panel-position") || "right";
    const panelPosition = ["left", "center", "right"].includes(position)
      ? position
      : "right";

    if (Main.panel.statusArea[this.uuid])
      Main.panel.statusArea[this.uuid] = null;

    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, panelPosition);
  }

  disable() {
    log("[MeetingTime] Disabling extension");
    this._scheduler?.stop();
    this._scheduler = null;

    this._overlay?.hide();
    this._overlay = null;
    this._backend = null;

    if (this._positionSignalId && this._settings)
      this._settings.disconnect(this._positionSignalId);
    this._positionSignalId = 0;

    this._indicator?.destroy();
    this._indicator = null;

    this._settings = null;
    log("[MeetingTime] Extension disabled");
  }
}
