# Manual smoke checklist

Record browser/device version, installation type, date, tester and result for every run.

## Installation and persistence

- [ ] Clean install opens the extension page from the toolbar action.
- [ ] Upgrade over 3.5.0 preserves settings, custom groups and usable cache entries.
- [ ] Static routes are not copied to IndexedDB during startup.
- [ ] Reopening the page does not duplicate listeners or UI components.

## Multipass tab lifecycle

- [ ] Existing loaded and logged-in Multipass tab is reused.
- [ ] Existing loading tab is awaited and then reused.
- [ ] Missing tab is created once, loaded, pinged and reused without a race.
- [ ] Logged-out state gives a useful login/refresh instruction.
- [ ] Returning from background or switching tabs recovers cleanly on iOS.
- [ ] Service-worker and content-script consoles have no unhandled rejection.

## Search parity

- [ ] Direct one-way search.
- [ ] Destination Anywhere and origin Anywhere.
- [ ] Anywhere-to-Anywhere direct search.
- [ ] One stop, same-day.
- [ ] One stop, overnight.
- [ ] Two stops, overnight.
- [ ] Allowed airport change inside the configured radius.
- [ ] Round trip with valid and invalid minimum return gaps.
- [ ] Multiple departure and return dates retain stable result ordering.
- [ ] Direct round trip with one outbound and one return date uses one availability request.
- [ ] One-way search sends the nearest valid reverse `flightDates` date and warms its cache key.
- [ ] One-stop and two-stop searches reuse paired reverse segments without losing non-mirrored routes.
- [ ] Paired HTTP 400 caches only outbound absence; a found connecting outbound still triggers inbound search.
- [ ] A second search does not duplicate results, listeners or API calls.

## Cancellation and errors

- [ ] Stop Search during the normal throttle delay finishes promptly.
- [ ] Stop Search during rate-limit pause finishes promptly.
- [ ] HTTP 400, 426, 429 and 501 follow the same behavior with debug on and off.
- [ ] HTML/invalid JSON response shows a controlled error.
- [ ] Dynamic URL discovery times out and releases observers/listeners.

## UI, accessibility and exports

- [ ] Dropdowns and modal close with Escape and restore focus.
- [ ] Inbound details expose the correct `aria-expanded` state.
- [ ] Airport, group and API-derived values render as text, not HTML.
- [ ] Layout remains usable after iPhone/iPad rotation and browser zoom/scale changes.
- [ ] CSV handles Unicode, quotes, tabs/newlines and direct-only visibility.
- [ ] CSV and debug downloads work; repeat downloads do not leak object URLs.
- [ ] Continue to customize submits the expected outbound key.
