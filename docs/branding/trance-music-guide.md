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
