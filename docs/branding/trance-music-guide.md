# TRANCE MUSIC Branding Guide

**Brand Identity:** Professional music streaming application  
**Color Scheme:** Black text on transparent/white backgrounds, with purple accent (#667eea)  
**Typography:** Bold modern sans-serif

## Logo Specifications

### Primary Logo
- **Text:** "TRANCE MUSIC"
- **Font:** Inter Bold, SF Pro Bold, or similar modern sans-serif
- **Color:** Pure black (#000000)
- **Background:** Transparent PNG
- **Format:** PNG with alpha channel

### Size Requirements

| Asset | Size | Purpose |
|-------|------|---------|
| Desktop Icon | 512x512px | Primary app icon |
| Mobile Icon | 1024x1024px | iOS/Android launcher |
| Splash Screen | 2732x2732px | Launch screen |
| Small Icon | 32x32px | Taskbar/notification |
| Medium Icon | 128x128px | Alt+Tab, dock |
| Large Icon | 256x256px | Settings, about |

## File Locations

```
app/src/
├── logo.png                      # Desktop (512x512)
├── mobile/
│   └── logo.png                  # Mobile (512x512)
└── src-tauri/
    └── icons/
        ├── 32x32.png
        ├── 128x128.png
        ├── 128x128@2x.png
        ├── icon.png              # 512x512
        ├── icon.icns             # macOS bundle
        └── icon.ico              # Windows bundle
```

## Color Palette

### Primary Colors
- **Brand Black:** #000000 (logo, primary text)
- **Brand Purple:** #667eea (accents, gradients)
- **Deep Purple:** #764ba2 (gradient end)

### UI Colors
- **Background Light:** #ffffff
- **Background Dark:** #1a1a1a
- **Surface Light:** #f5f5f5
- **Surface Dark:** #2a2a2a
- **Text Primary:** #000000 / #ffffff
- **Text Secondary:** #666666 / #999999

## Typography

### Font Stack
```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 
             'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 
             'Helvetica Neue', sans-serif;
```

### Font Weights
- **Regular:** 400 (body text)
- **Medium:** 500 (subheadings)
- **Semibold:** 600 (buttons, labels)
- **Bold:** 700 (headings, logo)

## Creating Logo Assets

### Using Design Software (Recommended)

**Figma/Sketch/Adobe XD:**
1. Create new artboard at 1024x1024px
2. Add text "TRANCE MUSIC"
3. Font: Inter Bold, size: 140pt
4. Color: #000000
5. Center horizontally and vertically
6. Optional: Add subtle gradient or shadow
7. Export as PNG with transparent background
8. Create additional sizes by scaling

**Online Tools:**
- [Canva](https://canva.com) - Free logo maker
- [Figma](https://figma.com) - Professional design tool
- [GIMP](https://gimp.org) - Free Photoshop alternative

### Using Command Line (ImageMagick)

```bash
# Install ImageMagick
# Ubuntu: sudo apt install imagemagick
# macOS: brew install imagemagick
# Windows: choco install imagemagick

# Generate 512x512 logo
convert -size 512x512 xc:transparent \
  -font Arial-Bold \
  -pointsize 60 \
  -fill black \
  -gravity center \
  -annotate +0+0 "TRANCE\nMUSIC" \
  app/src/logo.png

# Generate all required sizes
for size in 32 128 256 512 1024; do
  convert app/src/logo.png \
    -resize ${size}x${size} \
    app/src-tauri/icons/${size}x${size}.png
done

# Generate ICO (Windows)
convert app/src-tauri/icons/256x256.png \
        app/src-tauri/icons/128x128.png \
        app/src-tauri/icons/32x32.png \
        app/src-tauri/icons/icon.ico

# Generate ICNS (macOS)
# Requires additional steps - see Apple Icon Image format documentation
```

## Implementation Checklist

- [ ] Generate primary logo (512x512)
- [ ] Generate all icon sizes
- [ ] Replace `app/src/logo.png`
- [ ] Replace `app/src/mobile/logo.png`
- [ ] Replace all files in `app/src-tauri/icons/`
- [ ] Update `tauri.conf.json` productName
- [ ] Update `Cargo.toml` package name
- [ ] Update `package.json` name
- [ ] Update HTML `<title>` tags
- [ ] Search and replace remaining "REON" references
- [ ] Test desktop app icon
- [ ] Test mobile app icon
- [ ] Test Windows installer icon
- [ ] Test macOS DMG icon
- [ ] Update screenshots in README
- [ ] Update marketing materials

## Testing

### Desktop
```bash
npm run tauri build
# Check:
# - Window title bar shows "TRANCE MUSIC"
# - Taskbar icon is correct
# - About dialog shows correct name
```

### Mobile (Android)
```bash
npm run tauri android build
# Check:
# - Launcher icon is correct
# - Splash screen shows logo
# - App name in settings
```

### Mobile (iOS)
```bash
npm run tauri ios build
# Check:
# - Home screen icon
# - Launch screen
# - App Store metadata
```

## Legal Notes

- Ensure "TRANCE MUSIC" name is available for trademark
- Check domain availability: trancemusic.app, trancemusic.com
- Verify no conflicts with existing music apps
- Consider registering trademark if launching publicly

## Brand Voice

**Tone:** Professional, modern, accessible  
**Personality:** Music-focused, technical but friendly  
**Tagline Ideas:**
- "Your Music, Elevated"
- "Listen Without Limits"
- "Music Streaming, Reimagined"
- "Pure Audio Experience"

## Future Considerations

- Animated logo for splash screen
- App store screenshots with branding
- Social media profile images
- Website favicon
- Email signature logo
- Press kit materials

## Fallback artwork contract (2026-10-09, revised 2026-10-10)

The platform logo (`app/src/logo.png` + `app/src/mobile/logo.png`, byte-
identical to each other) is the **only** default artwork on either surface —
no-track idle covers, artless tracks, and every failed/slow thumbnail ladder
end here. Rationale: on a slow network covers arrive late or not at all, and
a local file paints instantly with zero network.

- `LOGO` constants (`art.js`, `mobile/shared.js`, `widget.js`) stay
  `"logo.png"` — same filename, new bytes; no import changes.
- **Revised 2026-10-10** (user: *"zoom in this and set only the main, don't
  show the background … still logo is not changed"*): `logo.png` is no longer
  a byte copy of `icon.png`. It is a **derived crop** — the bright mark of
  the 512×512 icon, background-keyed to alpha (luma ramp 30→110), padded to a
  square transparent canvas. The dark app-tile, its rounded corners and the
  `TRANCE MUSIC / CORE V2.4` caption are gone; the mark fills the frame.
  `icon.png` (launcher/branding source) is untouched. The CSS keeps a black
  backing so the white mark reads on any theme, and the zoom rule is deleted
  — the crop is baked in:
  ```css
  img[src$="logo.png"] { background: #000; }
  /* removed: .overflow-hidden > img[src$="logo.png"] { transform: scale(1.18); } */
  ```
  (desktop: `styles.css`; mobile: `mobile/index.html` `<style>`).
- Static boot defaults point at the local file, never remote: desktop
  `#master-album-cover` and `#bar-cover` ship `src="logo.png"` (the stage's
  old googleusercontent URL fetched on every boot, even offline).
- Widget blurred backdrops (`#wg-art`, `#wg-mini`, already `cover` + dark)
  fall back to the logo instead of empty.
- Ladder invariant (unchanged, verified by `app/tests/logo-fallback.test.mjs`):
  desktop/mobile `artFail` ends at `LOGO`; router `stampImages` keeps static
  design-export `<img>`s on the ladder so slow/dead demo URLs degrade to the
  logo instead of blanking.

> **REVERTED on desktop 2026-10-09** (user call — full desktop UI revert to
> HEAD): the `styles.css` rule, the `index.html` boot defaults and the
> `widget.js` backdrop fallback are gone. The mobile half (rule, bytes,
> ladder) stands; the gate is rescoped to mobile.
