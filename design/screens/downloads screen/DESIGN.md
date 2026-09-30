---
name: Sona Minimal Desktop
colors:
  surface: '#f9f9fb'
  surface-dim: '#d9dadc'
  surface-bright: '#f9f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f5'
  surface-container: '#eeeef0'
  surface-container-high: '#e8e8ea'
  surface-container-highest: '#e2e2e4'
  on-surface: '#1a1c1d'
  on-surface-variant: '#47464b'
  inverse-surface: '#2f3132'
  inverse-on-surface: '#f0f0f2'
  outline: '#77767b'
  outline-variant: '#c8c5cb'
  surface-tint: '#5f5e61'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1b1b1e'
  on-primary-container: '#858387'
  inverse-primary: '#c8c5ca'
  secondary: '#5f5e61'
  on-secondary: '#ffffff'
  secondary-container: '#e4e1e5'
  on-secondary-container: '#656467'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#1a1b22'
  on-tertiary-container: '#83838c'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e4e1e6'
  primary-fixed-dim: '#c8c5ca'
  on-primary-fixed: '#1b1b1e'
  on-primary-fixed-variant: '#47464a'
  secondary-fixed: '#e4e1e5'
  secondary-fixed-dim: '#c8c6c9'
  on-secondary-fixed: '#1b1b1e'
  on-secondary-fixed-variant: '#47464a'
  tertiary-fixed: '#e3e1ec'
  tertiary-fixed-dim: '#c6c5cf'
  on-tertiary-fixed: '#1a1b22'
  on-tertiary-fixed-variant: '#46464e'
  background: '#f9f9fb'
  on-background: '#1a1c1d'
  surface-variant: '#e2e2e4'
typography:
  headline-xl:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 38px
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 30px
    letterSpacing: -0.025em
  headline-md:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.015em
  body-lg:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 19px
    letterSpacing: -0.005em
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-md:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.02em
  label-mono:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: -0.01em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system embraces an uncompromising Scandinavian, reductive modern aesthetic tailored for focused desktop work. It pairs deliberate whitespace and architectural proportion with silent precision. The emotional tone is contemplative, poised, and tactile without being decorative. 

Visual priority is communicated through typographic contrast, tonal density, and layered spatial depth rather than chromatic alerts. Surfaces emulate frosted float glass, brushed mineral graphite, and natural paper stocks. Every interaction is quiet: borders are hairline-fine, transitions are instantaneous yet smooth, and layout geometry remains rigorous and uncluttered.

## Colors

The palette operates purely within a calibrated monochromatic spectrum. Chromatic color is intentionally omitted; meaning, state, and hierarchy are derived entirely from luminance, opacity, and contrast.

- **Base Canvas & Layering**:
  - `Surface 0 (App Canvas)`: `#F3F3F5` (subtle cool mist neutral)
  - `Surface 1 (Panels & Shells)`: `#FAFAFA`
  - `Surface 2 (Elevated Windows / Cards)`: `#FFFFFF`
  - `Surface Glass`: `rgba(255, 255, 255, 0.72)` paired with `backdrop-filter: blur(20px)`

- **Ink & Emphasis**:
  - `Ink High-Emphasis (Primary)`: `#18181B` (deep neutral charcoal)
  - `Ink Mid-Emphasis (Secondary)`: `#3F3F46`
  - `Ink Low-Emphasis (Tertiary / Placeholders)`: `#71717A`
  - `Hairline / Outlines`: `rgba(24, 24, 27, 0.06)` on light fields; `rgba(255, 255, 255, 0.5)` for reflective top edges

- **Interactive Monochromes**:
  - `Active Pill / Indicator`: `#18181B` with pure `#FFFFFF` ink
  - `Hover / Pressed States`: `#F4F4F5` and `#E4E4E7`

## Typography

Geist provides structured, neutral legibility with clean technical undertones that honor desktop density. Monospaced indicators rely on JetBrains Mono for system metrics, paths, and values.

- Headlines rely on tightened tracking (`-0.025em` to `-0.03em`) and medium/semibold weights to anchor sections without bold visual shouting.
- Desktop body sizes skew compact (`13px` default) to maximize canvas data density and workspace spatial awareness.
- Avoid all synthetic underlines or colored text accents. Optical weights (`400` vs `500` vs `600`) and tonal drops to `#71717A` establish all semantic relationships.

## Layout & Spacing

The layout is built around a pane-based desktop paradigm (sidebar navigation, contextual utility rail, and dominant workspace canvas) adhering to an explicit 4px baseline rhythm.

- **Panels & Shells**: Sidebar navigations are fixed or collapsible (240px default), utility sidecars use 320px fixed bounds, and the primary work canvas flexes fluidly.
- **Rhythm & Grid**: Use fluid columns within panels, anchored by `1rem` (16px) gutters. Outer shell padding uses `1.5rem` (24px) to retain breathing room against window frames.
- **Alignment**: Strict visual alignment to inner content containers. Vertical flow separates grouped properties by `space-sm` (8px), unrelated blocks by `space-lg` (20px), and top-level canvas sections by `space-xl` (32px).

## Elevation & Depth

Spatial layering relies on translucent float surfaces, optical hairline perimeters, and deeply dispersed ambient shadow cones rather than dramatic drops.

- **Hairline Framing**: Instead of heavy boundaries, structural regions employ a 1px border colored at `rgba(24, 24, 27, 0.07)`. For elevated sheets or cards, pair with an inner highlight inset: `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9)`.
- **Atmospheric Soft Shadow (Layer 1 - Overlays / Floats)**:
  `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px -4px rgba(24, 24, 27, 0.06)`
- **Modal / Focus Elevation (Layer 2 - Command palettes & Dialogs)**:
  `box-shadow: 0 0 0 1px rgba(24, 24, 27, 0.08), 0 12px 32px -6px rgba(24, 24, 27, 0.12), 0 24px 64px -12px rgba(24, 24, 27, 0.08)`
- **Glassmorphism**: Modals and navigation overlays use frosted backdrops (`background: rgba(250, 250, 250, 0.82); backdrop-filter: blur(24px) saturate(140%)`).

## Shapes

The design system implements a soft, precision-engineered geometric radius standard. Shapes avoid hyper-round pill forms for containers, maintaining a disciplined architectural feel.

- **Micro elements (Inputs, inline badges, list selections)**: `rounded` (`4px` / `0.25rem`).
- **Standard elements (Cards, toolbars, popovers)**: `rounded-lg` (`8px` / `0.5rem`).
- **Main App Panes & Windows**: `rounded-xl` (`12px` / `0.75rem`).
- **Pills / Status Dots**: Pure circle or fully rounded geometry is reserved strictly for miniature state indicators and active segment indicators.

## Components

- **Buttons**:
  - *Primary*: `#18181B` surface, `#FFFFFF` text, `0.25rem` radius, subtle top inner highlight (`inset 0 1px 0 rgba(255, 255, 255, 0.2)`). Minimal depression on `:active`.
  - *Secondary / Ghost*: Surface `#FFFFFF` with 1px `rgba(24, 24, 27, 0.08)` border. Text `#18181B`. Hover transitions to `#F4F4F5`.
  - *Tertiary*: Transparent fill, `#3F3F46` text. Hover fills to `rgba(24, 24, 27, 0.04)`.

- **Segmented Controls & Chips**:
  - Encased in a `#E4E4E7` / `#F4F4F5` track with a `0.25rem` radius.
  - Active segment: Pure `#FFFFFF` card with soft ambient micro-shadow (`0 1px 3px rgba(0,0,0,0.06)`), ink `#18181B`. Inactive segment: Text `#71717A`, transparent fill.

- **Inputs & Search Bars**:
  - Flat off-white base (`#FFFFFF`) with a 1px border in `rgba(24, 24, 27, 0.1)`.
  - Focus state avoids chromatic glow: transitions cleanly to `border-color: #18181B` with an understated ambient ring: `box-shadow: 0 0 0 1px #18181B`.
  - Prefix icons and keyboard shortcut badges render in `#71717A`.

- **Cards & Content Blocks**:
  - Base: `#FFFFFF` fill, 1px `rgba(24, 24, 27, 0.06)` border, `rounded-lg` (8px).
  - Hoverable items do not jump in size; they express interactive state through subtle surface lightening or border shift to `rgba(24, 24, 27, 0.16)`.

- **Checkboxes & Radios**:
  - Unchecked: `#FFFFFF` surface with `1.5px` border in `#3F3F46`.
  - Checked: Solid `#18181B` fill with `#FFFFFF` micro-check mark or center pip. No color flashes.

- **Command Palette & Dropdowns**:
  - Floated glass pane (`rgba(255, 255, 255, 0.88)` with backdrop blur).
  - List items have zero horizontal margin; selected items receive a clean background fill of `#F4F4F5` with ink `#18181B`.