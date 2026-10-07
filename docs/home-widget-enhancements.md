# Home Widget Enhancements

**Status:** Design specifications for improved home screen widget  
**Priority:** P2 (Nice to have)  
**Platform:** Desktop widget mode

## Current State

The desktop widget currently shows:
- Album artwork
- Track title and artist
- Basic playback controls
- Queue visibility

## Proposed Enhancements

### 1. Compact Mode Toggle

**Feature:** Allow users to switch between full and compact widget sizes

```javascript
// Settings options
const WIDGET_SIZES = {
  compact: { width: 300, height: 120 },
  standard: { width: 400, height: 240 },
  large: { width: 500, height: 320 },
};
```

**UI Location:** Widget settings gear icon → Size selector

### 2. Quick Actions Bar

**Feature:** Add frequently-used actions without opening main window

**Actions:**
- 🔀 Shuffle
- 🔁 Repeat
- ❤️ Like current track
- ⬇️ Download current track
- 📋 Add to playlist

**Design:**
```
┌─────────────────────────────┐
│   Album Art    │  Track Info │
│                │             │
│                │  Artist     │
├────────────────┴─────────────┤
│  ⏮️  ⏯️  ⏭️   🔀 ❤️ ⬇️ 📋 ⚙️ │
└─────────────────────────────┘
```

### 3. Mini Queue Preview

**Feature:** Show next 2-3 tracks in queue

**Compact view:**
```
Up Next:
• Track Name 2 - Artist
• Track Name 3 - Artist
```

**Toggle:** Click "Up Next" to expand/collapse

### 4. Spectrum Visualizer (Optional)

**Feature:** Live audio visualization in background

**Implementation:**
- Web Audio API analyzer
- Canvas-based frequency bars
- Toggleable via settings
- Low CPU impact (< 2%)

### 5. Transparency & Themes

**Feature:** Customizable appearance

**Options:**
- Opacity slider (50% - 100%)
- Theme: Light / Dark / Auto
- Accent color picker
- Background blur toggle

### 6. Always-on-Top Toggle

**Feature:** Keep widget above other windows

**Implementation:**
```javascript
invoke("set_widget_always_on_top", { enabled: true });
```

### 7. Jam Status Indicator

**Feature:** Show if in a room

**Display:**
```
┌─────────────────────┐
│ 🎵 In Room: #ABC123 │
│ Host: John (2 online)│
└─────────────────────┘
```

**Colors:**
- Host: Purple gradient
- Guest: Blue gradient
- Solo: Default

### 8. Smart Resize

**Feature:** Remember position and size across sessions

**Storage:**
```javascript
localStorage.setItem('widget-bounds', JSON.stringify({
  x: window.screenX,
  y: window.screenY,
  width: window.innerWidth,
  height: window.innerHeight,
}));
```

## Implementation Priority

### Phase 1 (High Impact, Low Effort)
1. ✅ Compact mode toggle
2. ✅ Quick actions bar
3. ✅ Always-on-top toggle

### Phase 2 (Medium Priority)
4. Mini queue preview
5. Transparency controls
6. Jam status indicator

### Phase 3 (Polish)
7. Spectrum visualizer
8. Theme customization
9. Smart resize memory

## Technical Considerations

### Performance
- Widget should use < 50MB RAM
- No heavy re-renders on timeupdate
- Debounce resize operations

### Cross-Platform
- Windows: Native Webview2
- macOS: Native WebKit
- Linux: GTK WebKit

### Testing
- Test with 1000+ track queue
- Verify memory doesn't grow over time
- Check CPU usage during playback
- Test all actions work without main window

## CSS Updates Needed

```css
/* Widget-specific styles */
.widget-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
}

.widget-compact .track-info {
  font-size: 0.875rem;
  line-height: 1.2;
}

.widget-actions {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.widget-action-btn {
  padding: 0.5rem;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: transform 0.1s, background 0.2s;
}

.widget-action-btn:hover {
  background: rgba(102, 126, 234, 0.1);
  transform: scale(1.1);
}

.widget-action-btn:active {
  transform: scale(0.95);
}

.widget-queue-preview {
  max-height: 120px;
  overflow-y: auto;
  font-size: 0.75rem;
  color: #666;
}

.widget-jam-badge {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}
```

## User Settings Schema

```javascript
{
  widget: {
    size: "standard", // compact | standard | large
    alwaysOnTop: false,
    transparency: 0.95,
    theme: "auto", // light | dark | auto
    showQueue: true,
    showVisualizer: false,
    showJamStatus: true,
    quickActions: ["shuffle", "like", "download"],
    position: { x: 100, y: 100 },
    dimensions: { width: 400, height: 240 },
  }
}
```

## Accessibility

- All buttons have proper ARIA labels
- Keyboard navigation support
- Screen reader announcements for track changes
- High contrast mode support
- Minimum touch target size: 44x44px

## Future Ideas

- Lyrics overlay toggle
- Playlist quick switcher
- Search from widget
- Custom background images
- Animated album art rotation
- Mini-player drag-to-reorder queue
- Gesture controls (swipe to skip)
- Notification integration
