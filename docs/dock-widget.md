# Dock statistics widget

Effects → Dock widget → CPU and network enables an optional, native favorite in
Dash to Dock. Its normal app delegate and drag handlers are unchanged: reorder it
among favorites as an ordinary icon. Dash to Dock must show favorites. Each dock
shows the same history; this is not a floating desktop widget.

The upper graph is CPU usage (0–100%, blue). The lower graph shows total download
(green) and upload (purple) on a shared, automatically scaled axis. The window is
32 one-second samples. Missing or stale readings leave gaps, not invented zeros.
Clicking the icon opens Vitals preferences.

## Data and lifecycle

Vitals is the only collector. Enabling the switch asks GNOME to install Vitals from
extensions.gnome.org if absent, using GNOME's confirmation dialog, then enables it.
Cancellation or an error leaves the widget disabled. Closing preferences cancels
the pending request. An existing installation is not replaced or downgraded.
Processor and Network must be enabled in Vitals; its polling interval is preserved.

Vitals does not offer a public metrics interface. The adapter observes its existing
`_values.returnIfDifferent` calls, after the original method completes. CPU uses the
raw group value; network uses Vitals' already computed `_networkSpeeds`. The adapter
does not read system files, start another collector, alter Vitals settings, or edit
Vitals' installed code. This private interface needs checking when Vitals changes.
Unsupported/missing data leaves an empty chart. Disable/re-enable reconnects it.

One shared one-second display timer serves all docks; hidden icons skip graph
generation. History is bounded to 32 samples. There is no frame-clock callback.
SVG bytes are in-memory `Gio.BytesIcon` objects (not files or serializable cached
icon names). Disabling releases timers, pending idles, signal subscriptions and the
Vitals wrapper, and restores the original dock icons.

The feature creates one launcher, `liquid-glass-vitals-widget.desktop`, in the user's
applications directory, and rewrites it only when its contents differ from the expected
launcher. The launcher cannot use `NoDisplay=true`: GNOME Shell filters favorites through
`ParentalControlsManager.shouldShowApp()`, which starts with `appInfo.should_show()`, so a
hidden launcher is silently dropped from the dock. The same check drives the app grid,
so the launcher also appears there. Switching the
widget off unpins only that launcher, remembers its previous position and deletes the
launcher. Pinning and unpinning edit the raw `favorite-apps` list, so favorites whose
launcher is temporarily missing are kept. Unpinning the icon from the dock switches the
widget off, and undoing that switches it back on, so the setting and the dock agree. Disabling
Liquid Glass itself keeps the favorite as a plain Vitals settings shortcut, preserving
order across logout/re-enable. The small launcher remains available for reuse.

## Verification

Automated coverage: source forwarding/restoration, no duplicate measurements,
bounded history, stale gaps, a shared timer across icons, hidden icons, settings
round-trips, icon recreation and Vitals restart. Native GTK verifies preference
construction without changing the user's profile.

Still requires a live Shell check: favorite insertion, drag/drop and persistence,
multiple monitors, resizing, theme changes, Vitals disabled/re-enabled, and memory
over a long run. Tests with adapters cannot establish interactive smoothness.

## Later: dock icon styles

Requested separately for a follow-up: keep MacTahoe's application icon shapes and
offer Original, Monochrome/Tinted and Translucent appearances, inspired by iOS.
Apply these locally to dock actors, without rewriting the system icon theme.
Transparency alone is not a glass material; readability and per-frame cost must be
checked before introducing refraction or background sampling on each icon.
These icon styles are not implemented by the statistics widget.
