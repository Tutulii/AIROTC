# Design System Specification: The Tactical Observatory

## 1. Overview & Creative North Star
**The Creative North Star: "The Sovereign Intelligence"**

This design system moves away from the "neon-drenched" sci-fi tropes of the past toward a sophisticated, editorial-grade "Tactical Lens." The goal is to provide the user with the feeling of sitting at a high-end intelligence terminal—one that values clarity, technical precision, and quiet authority over visual noise.

We break the "template look" by embracing **Tonal Depth** and **Intentional Asymmetry**. Instead of standard centered grids, we use weighted layouts that prioritize data flow. We utilize high-contrast typography scales and overlapping elements to create an interface that feels like a bespoke digital tool rather than a generic web application.

---

## 2. Colors: The Multi-Accent Palette
We have transitioned from a monochromatic teal to a sophisticated, multi-accent ecosystem. The color strategy is "Silent Base, Vocal Accents."

### Surface & Background Tokens
- **Background (Primary):** `#10131a` (The void; used for the furthest back layers)
- **Surface:** `#131720` (The base for main content areas)
- **Elevated Surface:** `#1A1F2E` (For modals, cards, and floating panels)

### Functional Accents
- **Primary Teal (`#46f1c5`):** Reserved for high-priority interactive elements and brand identifiers.
- **Secondary Blue (`#3B82F6`):** Used for Information states, Buyer roles, and text links.
- **Success Green (`#10B981`):** Strictly for "BUY" actions and "Completed" statuses.
- **Error Red (`#EF4444`):** Strictly for "SELL" actions and "Failed" statuses.
- **Elite Gold (`#F5C842`):** Reserved exclusively for Elite Tier badges and high-value status indicators.

### The "No-Line" Rule
Prohibit the use of 1px solid borders for sectioning. Boundaries must be defined solely through **Background Color Shifts**. For instance, a `surface-container-low` section sitting on a `surface` background provides all the definition a user needs without the visual clutter of a stroke.

### Glass & Gradient Rule
To achieve a "Tactical" feel, use **Glassmorphism** for floating elements. Utilize semi-transparent surface colors with a `backdrop-blur` of 8px–12px. 
*   **Signature Texture:** Use a subtle linear gradient from `Primary Teal` to `Secondary Blue` (at 15% opacity) for Hero backgrounds or main CTAs to provide a professional "soul" that flat colors lack.

---

## 3. Typography: Editorial Authority
The hierarchy is designed to balance the high-tech impact of Space Grotesk with the functional clarity of Inter.

| Level | Token | Font Family | Size | Weight | Intent |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Display** | `display-lg` | Space Grotesk | 3.5rem | 700 | Hero statements, high-impact data |
| **Headline** | `headline-md` | Space Grotesk | 1.75rem | 600 | Page titles, major section headers |
| **Title** | `title-md` | Inter | 1.125rem | 500 | Card titles, sub-sections |
| **Body** | `body-md` | Inter | 0.875rem | 400 | General reading, descriptions |
| **Technical** | `mono-sm` | JetBrains Mono | 0.75rem | 500 | Deal IDs, Wallet Addresses, Code |

**Typography Strategy:** Use `Space Grotesk` with tight letter-spacing (-0.02em) for an authoritative, "intelligence report" aesthetic. Use `JetBrains Mono` for any value that is subject to change or requires precise reading (e.g., price flux).

---

## 4. Elevation & Depth: Tonal Layering
We do not use drop shadows to indicate height; we use light.

*   **The Layering Principle:** Depth is achieved by stacking surface-container tiers. A `surface-container-highest` card should sit atop a `surface-container-low` background. This creates a natural "lift."
*   **Ambient Shadows:** If a floating effect (like a dropdown) is required, use a 24px blur shadow with 6% opacity, tinted with the `Primary Teal` color. Never use pure black shadows.
*   **The "Ghost Border":** For cards, use the `outline-variant` (`#2A3042`) at 40% opacity. It should feel like a suggestion of a border, not a hard cage.
*   **Animation Cues:** Use "Pulsing Indicators" (a soft glow expansion) for live market states and "Flowing Lines" (a subtle CSS shimmer) for progress bars to keep the interface feeling alive.

---

## 5. Components: Functional Intelligence

### Buttons
*   **Primary:** Solid `Primary Teal` with `on-primary` text. No border.
*   **Secondary:** Ghost style. Transparent background with a `Secondary Blue` "Ghost Border."
*   **Tertiary:** No background, no border. Pure text with an underline on hover.

### Inputs & Fields
*   **Style:** `surface-container-highest` background with a bottom-only 2px border that illuminates to `Primary Teal` on focus.
*   **Technical Data:** All numerical input must use `JetBrains Mono`.

### Cards & Lists
*   **Forbid Dividers:** Never use horizontal rules (`<hr>`). Separate list items using 8px of vertical whitespace or a subtle background shift on hover (`surface-bright`).
*   **Interactive Cards:** On hover, cards should transition from `surface-container` to `surface-container-high` with a 200ms ease-in-out curve.

### Tactical HUD (New Component)
*   A pinned, semi-transparent footer or sidebar using **Glassmorphism** that displays live "Heartbeat" data (Gas prices, network status) using `label-sm` in `JetBrains Mono`.

---

## 6. Do’s and Don’ts

### Do
*   **Do** use intentional asymmetry. Align high-level data to the left and technical IDs to the right to create a balanced "Scanning" path.
*   **Do** use `Muted #64748B` for all labels to ensure the `Primary #E2E8F0` data values pop.
*   **Do** use "Breathing Room." If an element feels cramped, double the padding. This is a premium experience, not a spreadsheet.

### Don’t
*   **Don’t** use monochromatic teal for everything. If a user is buying, the UI must reflect `Success Green`. If they are selling, `Error Red`.
*   **Don’t** use standard 1px borders to separate content. Use the Tonal Layering principle.
*   **Don’t** use `Space Grotesk` for body text. It is a display face and loses readability at small scales.
*   **Don’t** use high-contrast shadows. The "Tactical Lens" is lit from the front, not the top.