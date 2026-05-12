import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";

import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { deriveMeetingPresentation } from "./presentation.js";
import { nowEpochSeconds, openDefaultCalendar } from "./util.js";

const PANEL_ICON_NAME = "x-office-calendar-symbolic";

export const MeetingIndicator = GObject.registerClass(
  class MeetingIndicator extends PanelMenu.Button {
    _init(settings, callbacks) {
      super._init(0.5, "MeetingTime");

      this._settings = settings;
      this._callbacks = callbacks;

      this._events = [];
      this._status = {
        hasCompletedInitialRefresh: false,
        selectedCalendarCount: 0,
        discoveredCalendarCount: 0,
        widgetStatus: "loading",
      };
      this._countdownTimerId = 0;
      this._panelButtonContent = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "meetingtime-indicator-content",
      });
      this._panelIcon = new St.Icon({
        icon_name: PANEL_ICON_NAME,
        style_class: "meetingtime-indicator-icon",
        y_align: Clutter.ActorAlign.CENTER,
        fallback_icon_name: PANEL_ICON_NAME,
      });
      this._label = new St.Label({
        text: "Loading...",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "meetingtime-indicator-label",
      });
      this._panelButtonContent.add_child(this._panelIcon);
      this._panelButtonContent.add_child(this._label);
      this.add_child(this._panelButtonContent);

      this._statusItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "meetingtime-status-item",
      });
      this._statusItemButtonContent = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "meetingtime-status-item-button-content",
      });
      this._statusItemButtonIcon = new St.Icon({
        icon_name: "emblem-system-symbolic",
        style_class: "meetingtime-status-item-button-icon",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._statusItemButtonLabel = new St.Label({
        text: "Settings",
        style_class: "meetingtime-status-item-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._statusItemButtonContent.add_child(this._statusItemButtonIcon);
      this._statusItemButtonContent.add_child(this._statusItemButtonLabel);
      this._statusItemButton = new St.Button({
        style_class: "button",
        can_focus: true,
        reactive: true,
        accessible_name: "Open settings",
      });
      this._statusItemButton.set_child(this._statusItemButtonContent);
      this._statusItemButton.connect("clicked", () => {
        this.menu.close();
        this._callbacks.onOpenPrefs?.();
      });
      this._calendarItemButtonContent = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "meetingtime-status-item-button-content",
      });
      this._calendarItemButtonIcon = new St.Icon({
        icon_name: "x-office-calendar-symbolic",
        style_class: "meetingtime-status-item-button-icon",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._calendarItemButtonLabel = new St.Label({
        text: "Calendar",
        style_class: "meetingtime-status-item-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._calendarItemButtonContent.add_child(this._calendarItemButtonIcon);
      this._calendarItemButtonContent.add_child(this._calendarItemButtonLabel);
      this._calendarItemButton = new St.Button({
        style_class: "button",
        can_focus: true,
        reactive: true,
        accessible_name: "Open calendar",
      });
      this._calendarItemButton.set_child(this._calendarItemButtonContent);
      this._calendarItemButton.connect("clicked", () => {
        this.menu.close();
        openDefaultCalendar();
      });
      this._inProgressHeader = new PopupMenu.PopupMenuItem("In Progress", {
        reactive: false,
        can_focus: false,
      });
      this._inProgressSection = new PopupMenu.PopupMenuSection();
      this._inProgressHeader.visible = false;
      this._inProgressSection.actor.visible = false;
      this.menu.addMenuItem(this._inProgressHeader);
      this.menu.addMenuItem(this._inProgressSection);

      this._upcomingHeader = new PopupMenu.PopupMenuItem("Upcoming", {
        reactive: false,
        can_focus: false,
      });
      this._upcomingSection = new PopupMenu.PopupMenuSection();
      this._upcomingHeader.visible = false;
      this._upcomingSection.actor.visible = false;
      this.menu.addMenuItem(this._upcomingHeader);
      this.menu.addMenuItem(this._upcomingSection);

      this._disabledMessageItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "meetingtime-status-item",
      });
      this._disabledMessageItem.x_align = Clutter.ActorAlign.CENTER;
      this._disabledMessageLabel = new St.Label({
        text: "Select calendars for alerts",
        style_class: "meetingtime-disabled-message-label",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this._disabledMessageLabel.clutter_text.line_wrap = true;
      this._disabledMessageLabel.clutter_text.line_wrap_mode =
        Pango.WrapMode.WORD_CHAR;
      this._disabledMessageLabel.clutter_text.ellipsize =
        Pango.EllipsizeMode.NONE;
      this._disabledMessageItem.add_child(this._disabledMessageLabel);
      this._disabledMessageItem.visible = false;

      this._noEventsMessageItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "meetingtime-status-item",
      });
      this._noEventsMessageLabel = new St.Label({
        text: "No upcoming events",
        style_class: "meetingtime-disabled-message-label",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this._noEventsMessageLabel.clutter_text.line_wrap = true;
      this._noEventsMessageLabel.clutter_text.line_wrap_mode =
        Pango.WrapMode.WORD_CHAR;
      this._noEventsMessageLabel.clutter_text.ellipsize =
        Pango.EllipsizeMode.NONE;
      this._noEventsMessageItem.add_child(this._noEventsMessageLabel);
      this._noEventsMessageItem.visible = false;

      this._footerSeparator = new PopupMenu.PopupSeparatorMenuItem();
      this._footerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "meetingtime-status-item",
      });
      this._footerRow = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "meetingtime-footer-row",
      });
      this._footerRow.add_child(this._statusItemButton);
      this._footerRow.add_child(this._calendarItemButton);
      this.menu.addMenuItem(this._disabledMessageItem);
      this.menu.addMenuItem(this._noEventsMessageItem);
      this.menu.addMenuItem(this._footerSeparator);
      this._footerItem.add_child(this._footerRow);
      this.menu.addMenuItem(this._footerItem);
      this._statusItem.visible = true;

      this._countdownTimerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        30,
        () => {
          this._renderStatus(this._derivePresentation());
          return GLib.SOURCE_CONTINUE;
        },
      );

      this._settings.connect("changed::no-events-label", () => {
        this._renderStatus(this._derivePresentation());
      });
    }

    destroy() {
      if (this._countdownTimerId) {
        GLib.source_remove(this._countdownTimerId);
        this._countdownTimerId = 0;
      }

      super.destroy();
    }

    setEvents(events) {
      this._events = events;
      log(`[MeetingTime] Indicator received ${events.length} visible events`);
      this._renderPresentation();
    }

    setStatus(status) {
      this._status = {
        ...this._status,
        ...(status ?? {}),
      };
      this._renderPresentation();
    }

    _derivePresentation() {
      return deriveMeetingPresentation({
        events: this._events,
        status: this._status,
        enabled: this._settings.get_boolean("enabled"),
        noEventsLabel: this._settings.get_string("no-events-label"),
        now: nowEpochSeconds(),
      });
    }

    _renderPresentation() {
      const presentation = this._derivePresentation();

      this._renderStatus(presentation);
      this._renderEvents(presentation);
    }

    // Keep the indicator focused on rendering. Shared presentation rules
    // should live in the derived view-model layer, not duplicated here.
    _renderStatus(presentation) {
      this._label.set_text(presentation.label);
      this._disabledMessageItem.visible = presentation.showDisabledMessage;
      this._noEventsMessageItem.visible = presentation.showNoEventsMessage;
      this._statusItem.visible = true;
    }

    // This renders the menu from the same event set that drives the label.
    // Grouping and empty-state decisions should stay in the shared presenter.
    _renderEvents(presentation) {
      this._renderUpcomingEvents(presentation.upcomingGroups);

      this._renderSection(
        this._inProgressSection,
        presentation.inProgressEvents,
        (eventView) => {
          const item = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
          });
          const titleLabel = new St.Label({
            text: eventView.title,
            style_class: "meetingtime-event-title",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
          });
          item.add_child(titleLabel);
          item.connect("activate", () => {
            this._callbacks.onShowEventAlert?.(eventView.event.id);
          });
          if (eventView.canJoin) {
            const joinButton = new St.Button({
              style_class:
                "meetingtime-button meetingtime-button-join meetingtime-button-compact",
              can_focus: true,
              reactive: true,
              label: "Join",
              y_align: Clutter.ActorAlign.CENTER,
            });
            joinButton.connect("clicked", () => {
              this._callbacks.onJoinEvent?.(eventView.event.id);
            });
            item.add_child(joinButton);
          }
          return item;
        },
      );
    }

    _renderUpcomingEvents(groups) {
      this._upcomingSection.removeAll();

      const hasEvents = groups.length > 0;
      this._upcomingSection.actor.visible = hasEvents;
      this._upcomingHeader.visible = hasEvents;

      for (const { label, events } of groups) {
        if (label) {
          const dayHeader = new PopupMenu.PopupMenuItem(label, {
            reactive: false,
            can_focus: false,
          });
          dayHeader.add_style_class_name("meetingtime-day-header");
          this._upcomingSection.addMenuItem(dayHeader);
        }

        for (const eventView of events) {
          const item = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
          });
          const titleLabel = new St.Label({
            text: eventView.title,
            style_class: "meetingtime-event-title",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
          });
          item.add_child(titleLabel);
          if (eventView.relativeTime) {
            const timeLabel = new St.Label({
              text: eventView.relativeTime,
              style_class: "meetingtime-event-time",
              y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(timeLabel);
          }
          item.connect("activate", () => {
            this._callbacks.onShowEventAlert?.(eventView.event.id);
          });
          this._upcomingSection.addMenuItem(item);
        }
      }
    }

    _renderSection(section, eventViews, makeItem) {
      section.removeAll();

      const hasEvents = eventViews.length > 0;
      section.actor.visible = hasEvents;

      const header =
        section === this._upcomingSection
          ? this._upcomingHeader
          : this._inProgressHeader;
      header.visible = hasEvents;

      for (const eventView of eventViews)
        section.addMenuItem(makeItem(eventView));
    }
  },
);
