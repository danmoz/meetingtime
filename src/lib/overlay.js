import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { deriveOverlayPresentation } from "./presentation.js";
import { nowEpochSeconds } from "./util.js";

export class MeetingOverlay {
  constructor(settings) {
    this._settings = settings;

    this._root = null;
    this._dialog = null;
    this._countdownLabel = null;
    this._countdownTimerId = 0;
    this._presentRetryTimerId = 0;
    this._modalGrab = null;
    this._monitorSignalId = 0;
    this._stageSignalId = 0;

    this._event = null;
    this._handlers = null;
    this._options = null;
    this._onClosed = null;
    this._isHiding = false;
  }

  show(event, handlers, options = {}) {
    this.hide();

    this._event = event;
    this._handlers = handlers;
    this._options = options;
    this._onClosed = options.onClosed ?? null;
    this._isHiding = false;

    this._buildUi();
    this._updateCountdown();
    this._startCountdownTimer();
  }

  _derivePresentation() {
    return deriveOverlayPresentation(this._event, nowEpochSeconds(), {
      snoozeMinutes: this._settings.get_int("default-snooze-minutes"),
      triggerSource: this._options?.triggerSource,
    });
  }

  _handleButtonAction(action, snoozeMinutes) {
    if (action === "join") {
      this._handlers?.onJoin?.();
      return;
    }

    if (action === "ignore") {
      this._handlers?.onIgnore?.();
      return;
    }

    if (action === "dismiss") {
      this._handlers?.onDismiss?.();
      return;
    }

    if (action === "snooze") this._handlers?.onSnooze?.(snoozeMinutes);
  }

  _handleKeyPress(event, presentation, snoozeMinutes) {
    const symbol = event.get_key_symbol();
    const defaultButton = presentation.buttons.find(
      (button) => button.isDefault,
    );

    if (
      symbol === Clutter.KEY_Escape ||
      symbol === Clutter.KEY_d ||
      symbol === Clutter.KEY_D
    ) {
      this._handleButtonAction("dismiss", snoozeMinutes);
      return Clutter.EVENT_STOP;
    }

    if (
      (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) &&
      defaultButton
    ) {
      this._handleButtonAction(defaultButton.action, snoozeMinutes);
      return Clutter.EVENT_STOP;
    }

    if (
      presentation.canJoin &&
      (symbol === Clutter.KEY_j || symbol === Clutter.KEY_J)
    ) {
      this._handleButtonAction("join", snoozeMinutes);
      return Clutter.EVENT_STOP;
    }

    if (symbol === Clutter.KEY_i || symbol === Clutter.KEY_I) {
      this._handleButtonAction("ignore", snoozeMinutes);
      return Clutter.EVENT_STOP;
    }

    if (
      presentation.buttons.some((button) => button.action === "snooze") &&
      (symbol === Clutter.KEY_s || symbol === Clutter.KEY_S)
    ) {
      this._handleButtonAction("snooze", snoozeMinutes);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  hide() {
    if (this._isHiding) return;

    this._isHiding = true;
    this._stopCountdownTimer();

    if (this._stageSignalId && global.stage) {
      global.stage.disconnect(this._stageSignalId);
      this._stageSignalId = 0;
    }

    if (this._presentRetryTimerId) {
      // Cancel any deferred presentation attempt when the overlay is
      // going away; otherwise a stale retry could race the teardown.
      GLib.source_remove(this._presentRetryTimerId);
      this._presentRetryTimerId = 0;
    }

    if (this._monitorSignalId && global.display) {
      global.display.disconnect(this._monitorSignalId);
      this._monitorSignalId = 0;
    }

    if (!this._root) {
      this._releaseModalGrab();
      this._destroyOverlay();
      return;
    }

    this._root.ease({
      opacity: 0,
      duration: 240,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        this._releaseModalGrab();
        this._destroyOverlay();
      },
    });
  }

  _buildUi() {
    const presentation = this._derivePresentation();

    this._root = new St.Widget({
      style_class: "meetingtime-overlay-root",
      reactive: true,
      can_focus: true,
      x_expand: true,
      y_expand: true,
      layout_manager: new Clutter.BinLayout(),
      opacity: 0,
    });

    const backdrop = new St.Widget({
      style_class: "meetingtime-overlay-backdrop",
      x_expand: true,
      y_expand: true,
    });
    this._root.add_child(backdrop);

    this._dialog = new St.BoxLayout({
      style_class: "meetingtime-overlay-dialog",
      vertical: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._root.add_child(this._dialog);

    const heading = new St.Label({
      style_class: "meetingtime-overlay-heading",
      text: presentation.heading,
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._dialog.add_child(heading);

    const titleLabel = new St.Label({
      style_class: "meetingtime-overlay-title",
      text: presentation.title,
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._dialog.add_child(titleLabel);

    const metaLabel = new St.Label({
      style_class: "meetingtime-overlay-meta",
      text: presentation.meta,
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._dialog.add_child(metaLabel);

    if (presentation.location) {
      const locationLabel = new St.Label({
        style_class: "meetingtime-overlay-location",
        text: presentation.location,
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._dialog.add_child(locationLabel);
    }

    this._countdownLabel = new St.Label({
      style_class: "meetingtime-overlay-countdown",
      text: "",
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._dialog.add_child(this._countdownLabel);

    const buttonBox = new St.BoxLayout({
      style_class: "meetingtime-overlay-buttons",
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._dialog.add_child(buttonBox);

    const snoozeMinutes = this._settings.get_int("default-snooze-minutes");
    for (const buttonPresentation of presentation.buttons) {
      const button = new St.Button({
        style_class: buttonPresentation.isDefault
          ? "meetingtime-button meetingtime-button-default"
          : "meetingtime-button",
        can_focus: true,
        reactive: true,
        label: buttonPresentation.label,
        accessible_name: `${buttonPresentation.label}, shortcut ${buttonPresentation.shortcutLabel}`,
      });
      button.connect("clicked", () => {
        this._handleButtonAction(buttonPresentation.action, snoozeMinutes);
      });
      buttonBox.add_child(button);
    }

    this._root.connect("key-press-event", (_actor, event) => {
      return this._handleKeyPress(event, presentation, snoozeMinutes);
    });

    Main.layoutManager.uiGroup.add_child(this._root);
    this._stageSignalId = global.stage.connect("notify::allocation", () => {
      this._presentWhenReady();
    });

    this._presentWhenReady();
  }

  _syncToStage() {
    if (!this._root) return;

    this._root.set_position(0, 0);
    this._root.set_size(global.stage.width, global.stage.height);
  }

  _presentWhenReady() {
    if (!this._root || this._modalGrab) return;

    // GNOME Shell can call into the alert path before the stage has a
    // usable allocation during startup. Grabbing modal input too early
    // would block the desktop while the overlay is still effectively
    // invisible, so wait until the stage reports real dimensions.
    if (!global.stage || global.stage.width <= 0 || global.stage.height <= 0) {
      if (!this._presentRetryTimerId) {
        this._presentRetryTimerId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          50,
          () => {
            this._presentRetryTimerId = 0;
            this._presentWhenReady();
            return GLib.SOURCE_REMOVE;
          },
        );
      }
      return;
    }

    if (this._presentRetryTimerId) {
      GLib.source_remove(this._presentRetryTimerId);
      this._presentRetryTimerId = 0;
    }

    // Only once the stage is ready do we take the modal grab and animate
    // the overlay in. That keeps input handling and visibility in sync.
    this._syncToStage();
    this._modalGrab = Main.pushModal(this._root, {
      actionMode: Shell.ActionMode.ALL,
    });
    if (!this._modalGrab) {
      log("[MeetingTime] Could not acquire modal grab for overlay");
      return;
    }

    this._root.grab_key_focus();
    this._root.ease({
      opacity: 255,
      duration: 420,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _startCountdownTimer() {
    this._countdownTimerId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      1,
      () => {
        this._updateCountdown();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopCountdownTimer() {
    if (!this._countdownTimerId) return;

    GLib.source_remove(this._countdownTimerId);
    this._countdownTimerId = 0;
  }

  _updateCountdown() {
    if (!this._event || !this._countdownLabel) return;

    this._countdownLabel.set_text(this._derivePresentation().countdown);
  }

  _destroyOverlay() {
    const onClosed = this._onClosed;
    this._root?.destroy();
    this._root = null;
    this._dialog = null;
    this._countdownLabel = null;
    this._event = null;
    this._handlers = null;
    this._options = null;
    this._onClosed = null;
    this._isHiding = false;
    this._presentRetryTimerId = 0;
    onClosed?.();
  }

  _releaseModalGrab() {
    if (!this._modalGrab) return;

    Main.popModal(this._modalGrab);
    this._modalGrab = null;
  }
}
