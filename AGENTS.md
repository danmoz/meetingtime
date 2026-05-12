# AGENTS.md

This file is for coding agents working in this repository.

## Project Summary

`meetingtime` is a GNOME Shell extension that shows a modal full-screen alert shortly before events start. It also adds a top-panel indicator for status, quick refresh, and manual alert triggering.

The extension is written as GJS ES modules and runs inside GNOME Shell itself.

## Runtime Architecture

The live wiring happens in [`src/extension.js`](/home/danm/Git/meetingtime/src/extension.js):

- Creates GNOME settings via `this.getSettings()`
- Instantiates:
  - `CalendarBackend`
  - `MeetingOverlay`
  - `MeetingScheduler`
  - `MeetingIndicator`
- Connects scheduler updates into the indicator
- Starts the scheduler and forces an initial refresh

The main data flow is:

1. `MeetingScheduler.start()` starts the backend and refresh timers.
2. `CalendarBackend.refresh()` fetches calendar-server data.
3. Scheduler filters and sorts visible events, then schedules one timeout per upcoming alert.
4. `src/lib/presentation.js` derives display-only state such as the indicator label and dropdown groups from the current visible events.
5. When an alert fires, `MeetingOverlay.show()` grabs modal focus and renders the event UI.
6. `MeetingIndicator` renders the derived presentation state and allows refresh/manual alert actions.

The backend also keeps a small startup snapshot of the last normalized event state so the UI can populate immediately on startup before the first live refresh finishes.

[`src/lib/presentation.js`](/home/danm/Git/meetingtime/src/lib/presentation.js) is the shared derivation step for UI display state:

- Input: synced events plus the current settings and time
- Output: indicator text/state, dropdown sections, overlay text/state, and other display-only decisions

Keep that derivation separate from alert scheduling. `src/lib/scheduler.js` should continue owning timers, refresh, snooze, and alert dispatch, while the UI widgets consume derived presentation state.

## What The Code Uses Today

### Calendar Source

The primary source is GNOME Shell's calendar D-Bus service, not direct EDS access:

- Bus name: `org.gnome.Shell.CalendarServer`
- Object path: `/org/gnome/Shell/CalendarServer`
- Interface: `org.gnome.Shell.CalendarServer`

Implementation is in [`src/lib/calendarBackend.js`](/home/danm/Git/meetingtime/src/lib/calendarBackend.js). The backend:

- Creates a `Gio.DBusProxy`
- Calls `SetTimeRange`
- Listens for `EventsAddedOrUpdated` and `EventsRemoved`
- Normalizes events into the extension's internal event shape
- Enriches event URLs from GNOME CalendarServer / EDS-backed data
- Persists and reloads a small JSON startup snapshot through [`src/lib/startupSnapshot.js`](/home/danm/Git/meetingtime/src/lib/startupSnapshot.js)

### Scheduling

[`src/lib/scheduler.js`](/home/danm/Git/meetingtime/src/lib/scheduler.js) owns alert timing and refresh behavior:

- Maintains `_allEvents`, `_visibleEvents`, and `_calendarMap`
- Keeps `eventId -> timeoutId` maps for alert timers and snooze timers
- Reschedules on relevant settings changes
- Subscribes to `org.freedesktop.login1.Manager.PrepareForSleep` and refreshes after resume
- Prevents duplicate alerts with `_alertedEventIds`

Important behavior:

- Manual alert triggering from the panel calls `showAlertForEvent(eventId)`
- Snooze schedules a new timer and does not mutate the original event
- Ignore stores the event ID in scheduler memory, removes it from visible events, clears its alert/snooze timers, and prevents future alerts for that event during the current extension session
- Disabled calendars are filtered by `sourceId`
- An empty `enabled-calendar-uids` list means "all calendars disabled"

### Overlay

[`src/lib/overlay.js`](/home/danm/Git/meetingtime/src/lib/overlay.js) creates a full-stage modal `St.Widget`:

- Adds a backdrop and centered dialog
- Uses `Main.pushModal(...)` for focus grab
- Sizes itself to `global.stage`
- Updates a countdown label every second
- Renders the button list derived by `src/lib/presentation.js`
- Handles overlay shortcuts locally: `J` for Join when available, `Enter` for the default button, `I` for Ignore, `D`/`Escape` for Dismiss, and `S` for Snooze when visible

Current implementation note: it stretches over the shell stage rather than creating per-monitor overlays explicitly.
Overlay display strings, metadata, button ordering, default-button selection, action visibility, and shortcut labels come from `deriveOverlayPresentation(...)`; actor construction, modal focus, keyboard handling, and animation stay in `src/lib/overlay.js`.

### Indicator

[`src/lib/indicator.js`](/home/danm/Git/meetingtime/src/lib/indicator.js) adds a `PanelMenu.Button` with:

- Status label derived from the shared presentation layer
- Alerts enabled toggle
- Manual refresh
- Upcoming event list

The indicator refreshes its displayed countdown every 30 seconds.
It consumes `deriveMeetingPresentation(...)` and should not duplicate the rules for selecting the active event, empty state, or dropdown grouping.

### Presentation

[`src/lib/presentation.js`](/home/danm/Git/meetingtime/src/lib/presentation.js) derives display state from visible events:

- Chooses the indicator label
- Splits in-progress and upcoming events
- Groups upcoming events by day
- Truncates event titles for compact panel display
- Resolves disabled/loading/empty-state flags
- Chooses overlay heading, metadata, countdown text, button ordering, default-button selection, action visibility, and shortcut labels

It should stay pure and display-only. Do not add refresh, D-Bus, timeout, snooze, or alert-dispatch logic here.

### Preferences

[`src/prefs.js`](/home/danm/Git/meetingtime/src/prefs.js) builds a libadwaita preferences window. It binds directly to GSettings and includes controls for:

- alerts enabled
- all-day exclusion
- indicator panel position
- alert sound
- discovered calendar source selection
- no-events label selection
- force sync and startup snapshot clearing
- About tab metadata such as version, UUID, Shell compatibility, and project URL

### Utilities

[`src/lib/util.js`](/home/danm/Git/meetingtime/src/lib/util.js) contains the shared helpers worth reusing before adding new utility code:

- `extractMeetingUrl(event)`
- `maybePlayAlertSound(enabled)`
- time formatting helpers
  Event URL extraction currently prefers known video hosts from URL, location, or description text, and includes Google Meet delimiter parsing adapted from GNOME Calendar.

## Settings Schema

The source schema is in [`src/schemas/org.gnome.shell.extensions.meetingtime.gschema.xml`](/home/danm/Git/meetingtime/src/schemas/org.gnome.shell.extensions.meetingtime.gschema.xml).

Current keys:

- `enabled`
- `panel-position`
- `alert-minutes-before`
- `default-snooze-minutes`
- `exclude-all-day-events`
- `alert-horizon-hours`
- `refresh-interval-minutes`
- `force-refresh-request`
- `no-events-label`
- `enabled-calendar-uids`
- `alert-sound-file`

If you add or rename keys, remember this repo expects schema compilation after installation.

## File Map

- [`src/extension.js`](/home/danm/Git/meetingtime/src/extension.js): extension lifecycle and top-level wiring
- [`src/prefs.js`](/home/danm/Git/meetingtime/src/prefs.js): preferences window
- [`src/stylesheet.css`](/home/danm/Git/meetingtime/src/stylesheet.css): panel and overlay styling
- [`src/metadata.json`](/home/danm/Git/meetingtime/src/metadata.json): shell compatibility and extension metadata
- [`src/schemas/`](/home/danm/Git/meetingtime/src/schemas): GSettings schema source
- [`src/sounds/`](/home/danm/Git/meetingtime/src/sounds): bundled alert sounds
- [`src/lib/calendarBackend.js`](/home/danm/Git/meetingtime/src/lib/calendarBackend.js): D-Bus calendar backend and source metadata enrichment
- [`src/lib/startupSnapshot.js`](/home/danm/Git/meetingtime/src/lib/startupSnapshot.js): startup snapshot for the last normalized event state
- [`src/lib/scheduler.js`](/home/danm/Git/meetingtime/src/lib/scheduler.js): refresh loop, event filtering, alert/snooze timers
- [`src/lib/presentation.js`](/home/danm/Git/meetingtime/src/lib/presentation.js): derived indicator labels, dropdown event groups, and overlay display state
- [`src/lib/overlay.js`](/home/danm/Git/meetingtime/src/lib/overlay.js): modal event alert UI
- [`src/lib/indicator.js`](/home/danm/Git/meetingtime/src/lib/indicator.js): top-panel status menu
- [`src/lib/util.js`](/home/danm/Git/meetingtime/src/lib/util.js): shared helpers
- [`README.md`](/home/danm/Git/meetingtime/README.md): user-facing overview and manual install notes
- [`package.json`](/home/danm/Git/meetingtime/package.json): Node ESM mode marker for syntax checks
- [`mise.toml`](/home/danm/Git/meetingtime/mise.toml): local install helper task
- [`.github/workflows/run_tests.yml`](/home/danm/Git/meetingtime/.github/workflows/run_tests.yml): GitHub Actions `run_tests` workflow for formatting, linting, and tests on every push and pull request, with concurrency to avoid duplicate runs
- [`.github/workflows/ci.yml`](/home/danm/Git/meetingtime/.github/workflows/ci.yml): reusable GitHub Actions CI workflow for formatting, linting, and tests
- [`.github/workflows/build_release.yml`](/home/danm/Git/meetingtime/.github/workflows/build_release.yml): GitHub Actions `build_release` workflow for tests, packaging, and tagged releases
- [`mise bump-release`](/home/danm/Git/meetingtime/mise.toml): auto-increments `src/metadata.json`, commits, tags, and pushes the release tag
- [`mise format`](/home/danm/Git/meetingtime/mise.toml): Prettier-based formatter for JS, YAML, JSON, and Markdown
- [`mise pre-commit-checks`](/home/danm/Git/meetingtime/mise.toml): format and lint checks intended for generated git pre-commit hooks
- [`mise lint`](/home/danm/Git/meetingtime/mise.toml): fast Node syntax check across the JavaScript sources plus strict yamllint validation for GitHub workflow YAML using [.yamllint](/home/danm/Git/meetingtime/.yamllint)
- [`assets/`](/home/danm/Git/meetingtime/assets): screenshots used by the README
- [`src/lib/tests/presentation.test.js`](/home/danm/Git/meetingtime/src/lib/tests/presentation.test.js): GJS tests for pure presentation derivation logic
- [`src/lib/tests/calendarBackend.test.js`](/home/danm/Git/meetingtime/src/lib/tests/calendarBackend.test.js): GJS tests for backend normalization helpers
- [`src/lib/tests/scheduler.test.js`](/home/danm/Git/meetingtime/src/lib/tests/scheduler.test.js): GJS tests for scheduler alert sequencing and modal safety

## Development Notes

- This repo uses plain GJS modules. Keep imports consistent with the existing GNOME Shell style.
- The codebase uses 4-space indentation and semicolons.
- Prefer extending the existing event shape instead of creating parallel representations.
- Prefer a single presentation-derivation module/function for indicator labels, dropdown sections, and related UI state instead of reimplementing those rules in multiple widgets.
- When changing scheduler behavior, verify both automatic alerts and manual panel-triggered alerts still work.
- When changing the indicator placement, update the `panel-position` setting, preferences UI, and the extension wiring that adds the indicator to `Main.panel`.
- When changing filtering, remember the indicator and overlay both depend on scheduler output.
- When changing settings, update both the schema and the preferences UI.
- When changing styling, check that the overlay remains readable and keyboard-usable.
- Use `mise bump-release` to update `src/metadata.json`, commit the bump, tag it, and push the release tag.
- On completion of a code change, prompt the user to rerun `mise run debug-extension`, which will write logs to `session.log` for your review.
- The startup snapshot is bootstrap-only: Write it once on shutdown. Load it once on startup and delete it. Do NOT add live caching or mid-session reloads.

## Installation / Manual Verification

The current manual dev flow is described in [`README.md`](/home/danm/Git/meetingtime/README.md). In practice:

1. Install the extension into `~/.local/share/gnome-shell/extensions/meetingtime@danmoz`
2. Run `glib-compile-schemas .../schemas`
3. Enable or reload the extension in GNOME Shell

Automated coverage currently exists for presentation, backend, and scheduler logic. Run it with:

```sh
mise run tests
```

or directly:

```sh
gjs -m src/lib/tests/presentation.test.js
gjs -m src/lib/tests/calendarBackend.test.js
gjs -m src/lib/tests/scheduler.test.js
```

For formatting, run:

```sh
mise run format
```

To check formatting without rewriting files, run:

```sh
mise run format --check
```

For a fast syntax pass over the JavaScript sources, run:

```sh
mise run lint
```

To install a git pre-commit hook that runs the shared checks, run:

```sh
mise generate git-pre-commit --write --task=pre-commit-checks
```

Validation for GNOME Shell integration remains primarily manual inside a GNOME Shell session.

## CI / Release Packaging

[`.github/workflows/ci.yml`](/home/danm/Git/meetingtime/.github/workflows/ci.yml) contains the shared formatting, linting, and test jobs, which run in parallel and use `awalsh128/cache-apt-pkgs-action` for the test job.
[`.github/workflows/run_tests.yml`](/home/danm/Git/meetingtime/.github/workflows/run_tests.yml) calls the reusable CI workflow on every branch push and pull request, using concurrency to collapse duplicate reports for the same commit.
[`.github/workflows/build_release.yml`](/home/danm/Git/meetingtime/.github/workflows/build_release.yml) calls the reusable CI workflow, then packages the extension and publishes tagged releases after a `v*` tag push, using `awalsh128/cache-apt-pkgs-action` for packaging.

`mise run build-extension` copies `src/` into a temporary build directory and removes `lib/tests` before packaging so test-only JavaScript is not shipped in the extension zip.

Pushing a tag matching `v*` also creates a GitHub Release with the same `.shell-extension.zip` attached as the binary release package.

## Things To Treat Carefully

- Never modify `README.md` unless the user explicitly instructs you to do so.
- The extension currently depends on the shell calendar server contract as consumed in `src/lib/calendarBackend.js`. Do not replace that with speculative EDS or external API code unless the task explicitly requires it.
- The startup snapshot is not a live synchronization channel. Do not keep it updated during the session or use it as a watcher-driven state store.

## UI Notes

The app UI entrypoint is an indicator on the top bar.

Pseudo-code for the derived indicator status:

if all calendars are disabled: "Disabled"
else if at least one calendar has not yet been synced: "Loading"
else if there are no upcoming events: "No events"
else: the title of the next upcoming event

The same derived layer should also decide which events belong in the dropdown list and how they are grouped or labeled.
