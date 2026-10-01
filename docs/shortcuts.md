# Keyboard shortcuts

Every action below works **globally** — TRANCE MUSIC does not need focus. Two
variants exist and exactly one is registered per action at startup, so a press
can never fire twice:

| Action | Hyper (remapped Caps Lock) | Fallback (always works) |
| --- | --- | --- |
| Play / pause | `Caps Lock` + `Space` | `Ctrl + Alt + Space` |
| Search (opens Search, focuses the box) | `Caps Lock` + `F` | `Ctrl + Alt + F` |
| Now Playing | `Caps Lock` + `N` | `Ctrl + Alt + N` |
| Desktop widget on/off | `Caps Lock` + `W` | `Ctrl + Alt + W` |
| Download the playing track | `Caps Lock` + `D` | `Ctrl + Alt + D` |
| Track credits | `Caps Lock` + `I` | `Ctrl + Alt + I` |
| Play / pause (media key) | — | `Media Play/Pause` |
| Next track (media key) | — | `Media Next` |
| Previous track (media key) | — | `Media Previous` |

In-app key (window focused): `Ctrl + K` focuses the search box.

Hyper means `Ctrl + Alt + Shift + Win + <key>`: the app registers that chord,
and a remap tool makes `Caps Lock` produce it while held. If no remap tool is
running, the `Ctrl + Alt` fallback is registered instead. The media keys and
the tray menu's Play/Pause, Next and Previous send the same events as the
chords, so everything above covers them too.

## Setup: Caps Lock as Hyper

The app detects the remap tool **at startup** — restart TRANCE MUSIC after
installing or configuring one. Settings → Keyboard Shortcuts shows which mode
is active and can test the chords.

### Windows — PowerToys Keyboard Manager (recommended)

1. Install [PowerToys](https://learn.microsoft.com/windows/powertoys/) and open
   Settings → Keyboard Manager.
2. Choose **Remap a key**, press **+**, and set:
   | To send (key) | Mapped to (shortcut) |
   | --- | --- |
   | `Caps Lock` | `Ctrl + Alt + Shift + Win` |
3. Press **OK** to apply. Hold Caps Lock and any key from the table above.

If your Keyboard Manager version rejects a modifier-only target, use the
AutoHotkey recipe below instead.

### Windows — AutoHotkey (alternative)

Install [AutoHotkey v2](https://www.autohotkey.com/) and save this as
`caps-hyper.ahk`, then run it (add it to Startup to keep it):

```ahk
; Caps Lock held = Hyper (Ctrl+Alt+Shift+Win); tap alone = Escape.
#HotIf GetKeyState("CapsLock", "P")
Space::Send("^!+#Space")
f::Send("^!+#f")
n::Send("^!+#n")
w::Send("^!+#w")
d::Send("^!+#d")
i::Send("^!+#i")
#HotIf
CapsLock::Escape
```

### macOS — Karabiner-Elements

Add a complex modification with this rule (or paste it into Karabiner's
"Complex modifications" importer):

```json
{
  "title": "Caps Lock as Hyper",
  "rules": [
    {
      "description": "Caps Lock to Hyper",
      "manipulators": [
        {
          "type": "basic",
          "from": { "key_code": "caps_lock", "modifiers": { "optional": ["any"] } },
          "to": [
            { "key_code": "left_control" },
            { "key_code": "left_option" },
            { "key_code": "left_shift" },
            { "key_code": "left_command" }
          ]
        }
      ]
    }
  ]
}
```

### Linux — xremap

Copy the snippet from Settings → Keyboard Shortcuts (or use this), save as
`~/.config/xremap.yaml` and run `xremap`:

```yaml
keymap:
  - remap:
      CapsLock:
        held: [Control_L, Alt_L, Shift_L, Super_L]
        alone: Escape
```

## Troubleshooting

- **Nothing arrives on Caps chords** — is the remap tool running, and was the
  app restarted after setup? Settings → Keyboard Shortcuts shows the active
  mode; "default" means the tool was not detected at boot.
- **Shortcut conflicts** — if another application already owns one of the
  `Ctrl + Alt` combos, registration fails for that action only; the app keeps
  running and logs `shortcut conflict: <action>` (visible in the diagnostics
  panel). Quit the conflicting app or pick a free combo.
- **AltGr / non-US layouts** — `AltGr` behaves as `Ctrl + Alt`, so
  `AltGr` + `F`/`N`/`W`/`D`/`I` can look like the fallback chord. Use the Hyper
  variant if your layout collides.
- **Keyboard with no Caps Lock key** — remap another unused key (Right Ctrl,
  Menu) to Hyper with the same recipes, or stay on the fallback.
- **Media keys do nothing** — check the OS media overlay: the shortcuts use
  the system media keys, which the shell also shows a volume/transport popup
  for.
