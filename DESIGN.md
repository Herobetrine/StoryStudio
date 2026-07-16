# Story Studio Design System

## 1. Theme

Story Studio is a quiet, dense editorial workstation. Near-black surfaces recede behind manuscript text, while restrained vermilion marks selection, progress, and actions that change accepted writing.

## 2. Palette

| Token | Value | Role |
|---|---|---|
| Canvas | `oklch(0.16 0.009 55)` | Primary workspace |
| Panel | `oklch(0.19 0.01 55)` | Binder and inspector |
| Raised | `oklch(0.235 0.012 58)` | Inputs and selected surfaces |
| Text | `oklch(0.91 0.014 68)` | Primary text |
| Muted | `oklch(0.67 0.018 67)` | Metadata |
| Accent | `oklch(0.64 0.16 30)` | Vermilion selection and progress |
| Success | `oklch(0.72 0.12 151)` | Saved state |
| Danger | `oklch(0.64 0.19 28)` | Conflicts and destructive actions |

## 3. Typography

UI text uses `Microsoft YaHei UI`, `PingFang SC`, and `Noto Sans SC`. Manuscript text and editorial headings use `Songti SC`, `STSong`, and `Noto Serif SC`; this deliberately separates reading from operating. Counters use Cascadia Mono or the platform monospace fallback with tabular numerals. Chinese text keeps normal letter spacing.

## 4. Components

Buttons use the shared 4/6/8 px radius scale, a minimum 40 px target, visible focus, and `scale(0.96)` on press. Inputs are flush tool surfaces rather than floating cards. Icon-only actions use local Lucide SVG assets plus an accessible name and tooltip.

## 5. Layout

Desktop uses a binder, manuscript, and inspector grid. The manuscript owns the largest track and stays readable at roughly 78 characters. At 820 px or below, binder and inspector become mutually exclusive drawers over a full-width editor.

## 6. Depth

Depth comes from lightness steps between canvas, panel, raised, and hover surfaces. Dividers are one-pixel structural rules. Dark drop shadows are reserved for drawers and transient overlays where elevation is operationally meaningful.

## 7. Guardrails

- The first screen is the working tool, never a landing page.
- Do not place cards inside cards.
- Do not use gradients, glass blur, decorative blobs, or purple-blue accents.
- Do not animate layout properties.
- Do not hide accepted-text replacement behind a one-click default.
- Keep save, error, and generation states in fixed-size slots.
- Keep every Chinese label visible at 375 px.

## 8. Responsive Behavior

The desktop grid is verified at 1280 px. At 375 px, the header wraps into stable rows, the editor remains full height, and chapter/inspector drawers use explicit dynamic viewport dimensions. Safe-area insets, reduced motion, focus trapping, and 40 px touch targets are required.

## 9. Agent Guide

Use `--ss-canvas`, `--ss-panel`, `--ss-raised`, `--ss-text`, `--ss-muted`, and `--ss-accent` rather than adding raw colors. New command buttons use 40 px minimum height, 6 px radius, normal letter spacing, and a 120 ms transform/opacity transition. New manuscript surfaces use the serif stack at 16 to 18 px with line-height 1.9 and no decorative container.
