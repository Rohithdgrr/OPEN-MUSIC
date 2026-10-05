---
name: Sona Acoustic Minimal
colors:
  surface: '#f9f9f8'
  surface-dim: '#dadad9'
  surface-bright: '#f9f9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f3'
  surface-container: '#eeeeed'
  surface-container-high: '#e8e8e7'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1a1c1c'
  on-surface-variant: '#444748'
  inverse-surface: '#2f3130'
  inverse-on-surface: '#f1f1f0'
  outline: '#747878'
  outline-variant: '#c4c7c7'
  surface-tint: '#5f5e5e'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1c1b1b'
  on-primary-container: '#858383'
  inverse-primary: '#c8c6c5'
  secondary: '#5c5e62'
  on-secondary: '#ffffff'
  secondary-container: '#e1e2e7'
  on-secondary-container: '#626468'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#3e0500'
  on-tertiary-container: '#e65131'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e5e2e1'
  primary-fixed-dim: '#c8c6c5'
  on-primary-fixed: '#1c1b1b'
  on-primary-fixed-variant: '#474646'
  secondary-fixed: '#e1e2e7'
  secondary-fixed-dim: '#c5c6cb'
  on-secondary-fixed: '#191c1f'
  on-secondary-fixed-variant: '#45474b'
  tertiary-fixed: '#ffdad3'
  tertiary-fixed-dim: '#ffb4a4'
  on-tertiary-fixed: '#3e0500'
  on-tertiary-fixed-variant: '#8c1700'
  background: '#f9f9f8'
  on-background: '#1a1c1c'
  surface-variant: '#e2e2e2'
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 36px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Geist
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.025em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 26px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Geist
    fontSize: 17px
    fontWeight: '600'
    lineHeight: 22px
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.04em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.06em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  margin: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system expresses high-fidelity digital audio through an understated Scandinavian architectural lens: precise, disciplined, and calm. Designed strictly for handheld focus, it treats music playback not as an algorithmic feed, but as an intimate physical instrument—borrowing the deliberate tactility of bespoke Nordic audio hardware, gallery exhibition layouts, and precision audio workstation software.

The emotional signature is quiet authority and pure clarity. Dense technical audio parameters (lossless bitrates, sample rates, collaborative buffers) coexist with generous negative space and razor-sharp structural rules. Highlighting is purposeful and rare; visual noise is systematically stripped away to allow full-bleed album artwork, typography, and collaborative room state to command the viewport.

## Colors

The palette is rooted in neutral chalk, warm anodized aluminum, and carbon black, punctuated by a solitary precision indicator tint.

- **Primary (`#121212`)**: Pure soot black, utilized for dominant typography, structural bounding outlines, and active state indicators.
- **Secondary (`#5E6064`)**: Mid-tone slate gray for metadata, sub-labels, inactive states, and unbuffered audio scrubber tracks.
- **Tertiary (`#D64527`)**: An ultra-focused warm vermilion, inspired by reel-to-reel recording indicators and analog studio telemetry. Used exclusively for live broadcast statuses, collaborative session pings, and critical audio warnings (such as clipping or latency drops).
- **Neutral (`#F7F7F6`)**: Warm porcelain paper base. Provides a glare-free, organic light surface that avoids clinical digital white.

Surface steps use subtle tonal shifts rather than heavy fills: canvas sits at `#F7F7F6`, elevated modules at `#FFFFFF`, and recessed telemetry slots at `#EFEFEF`. Hairline borders leverage an ultra-subtle alpha tone: `rgba(18, 18, 18, 0.08)`.

## Typography

Typography establishes an unambiguous distinction between narrative musical discovery and scientific precision.

- **Geist** governs primary human-facing interfaces: titles, artist names, editorial room notes, and primary actions. Set with optical kerning and tightened negative tracking to mirror high-end Swiss architectural monographs.
- **JetBrains Mono** governs machine readouts, timing, and lossless telemetry: audio codecs (`FLAC 24-bit/192kHz`), buffer latencies, millisecond transport counters, participant counts, and structural table headers.

All labels in JetBrains Mono use tabular numerals (`tnum`) by default, preventing jitter during active millisecond scrub operations or dynamic sync adjustments in collaborative listening sessions.

## Layout & Spacing

The layout is built around mobile viewports (~390px base width, such as iPhone 14/15/16 Pro). It uses a 4-column fluid mobile grid anchored by `16px` (`1rem`) outer canvas margins and `12px` (`0.75rem`) internal column gutters.

Every touch interaction guarantees a minimum target zone of `44px × 44px`, even when visual icons or typographic indicators are as compact as `16px` to `20px`. The vertical rhythm adheres to an explicit 4px baseline matrix. Fluid vertical card layouts maintain edge alignment with inner padding steps (`space-md` or `space-lg`), keeping tactile scrubbers and room controls easily accessible to one-handed thumb movement.

## Elevation & Depth

This design system discards heavy dropshadows and blurred skeuomorphism in favor of structural hairline boundaries and micro-tonal surface layering.

- **Hairline Outlines**: Depth is demarcated by uniform 1px borders colored at `rgba(18, 18, 18, 0.08)` on light cards, intensifying to `rgba(18, 18, 18, 0.16)` on active, hovered, or expanded items.
- **Tonal Stepping**: 
  - Base layer (Canvas): `#F7F7F6`
  - Floating cards & sheets: `#FFFFFF` with a 1px perimeter border
  - Recessed interactive tracks (scrubbers, EQ bands): `#ECECEB` inset
- **Elevated Modals & Drawers**: The persistent bottom transport drawer uses a subtle diffused ambient shadow—`0 -4px 24px rgba(0, 0, 0, 0.04)`—coupled with an overhead 1px hairline border in `rgba(18, 18, 18, 0.06)`, maintaining clear separation from underlying scrolled queues without visual heaviness.

## Shapes

The geometric language is strictly structured, drawing inspiration from machined anodized aluminum audio consoles and Dieter Rams industrial design.

- **Primary Geometry**: Strict `roundedness: 1` (`4px` base radius, `8px` for cards and sheets). Edges are gently debossed rather than bulbous, keeping interface density high and lines clean.
- **Pills / Status Exceptions**: Circular or full-radius rounding is reserved exclusively for operational state badges (e.g. `LIVE SYNC`, session participant avatars, and transport play/pause hardware toggles). All parent structural envelopes remain clean, boxed, and disciplined.

## Components

### Persistent Bottom Transport Drawer
- **Collapsed Bar**: Docked 64px tall above safe area. Contains 44px square tactile hit zones: track thumbnail (36px rounded-xs), track and artist scroller (Geist Body-md), collaborative room avatars stack, and a solid 40px primary transport button.
- **Expanded Sheet**: Slides vertically to full-viewport height minus a 48px top status notch. Features high-res square album artwork with 4px corners, millisecond scrubbing slider with JetBrains Mono time indicators, and room participation slots.

### Audio Scrubber & Rotary Sliders
- **Track**: 2px thick hairline rail (`rgba(18, 18, 18, 0.12)`), filled dynamically in `#121212` for playback progress and `#D64527` for collaborative live playheads.
- **Handle**: 12px circular brass/black physical dot that blooms to an accessible 48px invisible touch capture boundary.

### Buttons & Transport Controls
- **Primary Action (Play/Pause/Join)**: Solid `#121212` background, `#FFFFFF` icon or label, 44px min-height, 4px border radius.
- **Secondary Action (Shuffle/Loop/Queue)**: Transparent background, 1px hairline border (`rgba(18, 18, 18, 0.12)`), `#121212` text/icon, 44px min-height.
- **Tertiary Utility**: Naked icon with 44px target bounds, changing color from `#5E6064` to `#121212` when engaged.

### Chips & Telemetry Badges
- Built with JetBrains Mono `label-sm`.
- Contained within 20px height pill frames with 1px border.
- Bitrate/Lossless Chip: `#FFFFFF` fill with `1px solid rgba(18, 18, 18, 0.12)` border.
- Live Broadcast Chip: Soft `#D64527` tinted text with a pulsing 6px circular dot indicator.

### Collaborative Room List & Queue Items
- 56px row height with hairline divider `rgba(18, 18, 18, 0.05)`.
- Left-aligned drag handle or track position index in JetBrains Mono.
- Right-aligned participant badge array showcasing micro-avatars (20px circular units with 1px white separation rings).

### Input Fields & Search
- Low-profile 44px height container, `#FFFFFF` background, 1px border.
- Geist Body-md placeholder text in `#5E6064`.
- Integrated audio filter dropdowns (e.g., `Lossless`, `Studio Masters`) styled using compact JetBrains Mono labels.