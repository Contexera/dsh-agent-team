# SVG avatar/character asset research

Date: 2026-09-01

## Scope and method

This is a bounded review of six small, established collections that could supply Agent avatar presets in the Team Client. The review is scoped to first-party repository README/LICENSE files, package metadata, and official asset documentation/source. “Static” means the source publishes SVG files that can be copied into this package; a JavaScript generator or hosted endpoint is evaluated separately. No production files, manifests, or generated files were changed.

The exact source, license text, and pinned version must be re-opened before any asset is copied. License and provenance conclusions below are shortlist guidance, not a substitute for final legal review of the exact files selected.

The existing UI uses quiet 24px/28px avatars, a stable per-member color, and a presence badge (`docs/frontend-design.md`). At that size, silhouette and one or two high-contrast features matter more than fine illustration detail.

## Shortlist

| Collection | License and redistribution | Static SVG evidence | 24px/28px identity and visual fit | Runtime/legal complexity | Result |
| --- | --- | --- | --- | --- | --- |
| **Open Peeps** | Pablo Stanley’s official download page states CC0 and says the library is free for commercial and personal use. Keep a provenance/license reference even though CC0 does not require attribution. | The official page offers flat SVG/PNG assets. It is a mix-and-match component library, not a ready-made avatar sprite sheet; a curated, pre-composed subset can be vendored. | Hand-drawn human line work can fit a quiet UI, but many strokes/details will merge at 24px and the visual language differs from the current geometric sample. | Low for a finite local subset; avoid shipping a browser-side composition engine. | **Legal/static fallback**, subject to visual sampling and manual composition. |
| **Open Doodles** | The official site presents the collection as free/open artwork; verify the exact current license notice at download time before redistribution. | The official site exposes individual SVG downloads. | Strong, simple black-line silhouettes read at small sizes, but the set is pose/scene oriented rather than a large set of distinct headshots, so identity separation is limited. | Low for a small copied subset, but source/provenance is site-based rather than a pinned package. | **Possible secondary source** only after license text and selected files are re-verified. |
| **Fluent Emoji** | Microsoft’s official repository publishes an MIT license. MIT permits redistribution and modification with the copyright and license text retained. | Official repository stores per-emoji SVG assets (including flat/color variants). They are ordinary files, not an API requirement. | Large coverage and clear facial/animal symbols make identities easy to distinguish at 24px. The detailed, shaded style is visually louder than the current minimalist DSH treatment; use only a deliberately narrow flat subset or recolor test. | Low technical complexity; moderate package size if many SVGs are copied. Preserve MIT notice. | **Legally straightforward, visually conditional.** |
| **Twemoji** | Official README separates code (MIT) from graphics (CC-BY 4.0). Graphics redistribution requires attribution and preservation of license/copyright notices; this is not “no-notice” bundling. | Official repository has an `assets/svg` tree containing static SVG emoji. | Excellent small-size recognition and broad identity symbols, but emoji styling and color palette may compete with the restrained UI. Human-face coverage is not an avatar system. | Low runtime complexity; ongoing attribution/notice work is required. | **Possible with explicit attribution; not preferred for human Agent portraits.** |
| **DiceBear (specific CC0 styles)** | DiceBear’s official style catalog says the software is MIT but each style has its own license. The official definitions for `Shapes`, `Cutouts`, `Blobs`, `Rings`, and `Thumbs` record **CC0 1.0**; do not generalize that to every style. | The source is a style definition/generator, but the official API and local libraries produce self-contained SVG. Generate a finite set once, pin the exact style/version/options, and vendor the resulting SVGs; do not call the hosted API at runtime. | `Shapes` is minimalist geometric; `Cutouts` is a character-like paper collage; `Blobs`/`Rings` are abstract. Their large shapes and configurable colors have stronger 24px potential than detailed portrait styles. | Moderate one-time generation and provenance work; no runtime dependency if outputs are checked in. Pinning avoids seed/version drift. | **Best practical candidate for a DSH-style trial:** start with `Shapes` and `Cutouts`, then keep only the stronger small-size outputs. |
| **OpenMoji** | Official repository licenses artwork CC BY-SA 4.0. Attribution is required and adaptations must be shared under the same license. | Official repository publishes static SVG artwork. | Very legible at 24px with broad symbols, but emoji appearance is not a close fit for human Agent portraits. | Legal obligations (attribution + share-alike) make downstream packaging and future edits harder. | **Exclude for this bundle unless a deliberate CC BY-SA distribution plan is approved.** |

## Permissive assets versus generators and unsuitable licenses

- **Permissive static assets:** Open Peeps and Open Doodles (CC0) have a clear redistribution path from their official download/source pages. DiceBear’s specific `Shapes`, `Cutouts`, `Blobs`, `Rings`, and `Thumbs` definitions also record CC0; Fluent Emoji (MIT) is permissive if the MIT notice is shipped. Twemoji is permissive only with its required CC-BY attribution.
- **Hosted/avatar APIs and runtime generators:** DiceBear’s hosted API and JavaScript generation are conveniences, not a reason to add network/runtime behavior to the Team Client. For this feature, generate a small pinned set once and vendor the final SVGs with source/license provenance.
- **Unsuitable license for a default bundle:** OpenMoji’s CC BY-SA 4.0 share-alike requirement is materially more restrictive than the rest of this plugin’s ordinary asset distribution. It is not recommended for the default presets.

## Recommendation

Pause custom art and prototype a **small, pre-rendered DiceBear CC0 subset** first: compare `Shapes` (minimal geometric) and `Cutouts` (character-like paper collage), using a pinned version/options and local SVG outputs. Render and inspect at 24px and 28px with the existing presence badge; keep only the silhouettes that remain distinct. Preserve the generated provenance metadata and record the exact style definition/license in package notices. Keep Open Peeps as the legal/static fallback if a human line-art direction is preferred, but do not add a DiceBear/API runtime dependency for this preset milestone.

## Open questions

1. Which exact Open Peeps/Open Doodles SVG files and combinations remain recognizable after rasterizing at 24px and 28px on light and dark themes?
2. Does the distribution need a visible in-product attribution panel, or is a package `NOTICE`/About entry sufficient for Twemoji or Fluent Emoji?
3. Are there trademark, personality-rights, or third-party-font concerns in any selected artwork that require a legal review beyond the repository license?
4. What maximum avatar asset budget (count and compressed bytes) is acceptable for the Web bundle?

## Addendum: candidate set evolution (2026-09-01, later sessions)

Direction changed several times after the initial shortlist; each step was a discussion-only preview, still no production code.

- Shortlisted DiceBear styles with verified licenses: Identicon, Bottts Neutral, Cameo, Rings (plus Shapes/Cutouts tried and dropped as too generic or too comedic for Team).
- Iterated Bottts Neutral + Identicon palettes (v2/v3 previews). Human then reviewed six additional Cameo/Rings candidates.
- Human restart decision: base the set on the six v3 Identicons exactly (fg/bg `0f1115/d3e2ff`, `4176e6/f1f3f5`, `283142/b49ad9`, `b94e5a/f6ded7`, `a36a20/f5e4c7`, `2f7f78/d6ece8`; seeds Reeve/Iris/Vera/Tars/Cole/Momo), and add six Bottts Neutral with deliberately calm, non-expressive faces in colors that do not reuse the Identicon palette.
- Calm-variant diagnostic (all eye enums × flat mouths): excluded `bulging`/`dizzy`/`happy`/`hearts`/`robocop` eyes, `roundFrame02` (googly), `shade01` (built-in red visor), `glow` (too faint at 24px), and mouths `bite`/`diagram`/`smile01`/`smile02`/`grill03` (teeth). Selected: `frame1`, `frame2`, `roundFrame01`, `round`, `sensor`, `eva` eyes with `square01`, `square02`, `grill01`, `grill02` mouths.
- Human-approved final set (2026-09-01, `artifacts/avatar-final-twelve-preview-v3.png`): six chosen Identicons + six Bottts Neutral.
- Final default behavior (Human correction, same day): the avatar is optional. An unselected avatar keeps the current deterministic initial+hue fallback — no random allocation and no "unused preset" assignment (the earlier random suggestion was retracted). The creation and edit pickers must therefore offer an explicit default/none state; clearing a preset returns a member to the fallback. Expressions locked after Human review; palette history: first muted set (slate/forest/olive/orange/plum/taupe) judged too restrained, vivid lift (green `3fa45c`, lime `8fc03a`, gold `f0b429`, orange `ef7d3a`, red `e0483f`, magenta `c2479e`) judged too bright. Final toning keeps the same hue families but matches the current default member-avatar tone exactly — saturation 42%, lightness 46%: green `44a765` (140°), lime `7ea744` (85°), gold `a79344` (48°), orange `a77244` (28°), red `a75144` (8°), magenta `a74486` (320°). These sit outside the Identicon blue/violet/rose/amber/teal families and stay pairwise distinct at 24px.
- Bottts Neutral remains “free for personal and commercial use” (bottts.com), not CC0; exact pinned asset/version terms must be recorded before release. Identicon is CC0 1.0.

## Primary sources

- Open Peeps official download/license page: <https://pablostanley.gumroad.com/l/openpeeps>
- Open Peeps official site: <https://www.openpeeps.com/>
- Open Doodles official site and SVG downloads: <https://www.opendoodles.com/>
- Fluent Emoji repository (README, LICENSE, `assets/` SVGs): <https://github.com/microsoft/fluentui-emoji>
- Twemoji repository (README, LICENSE, `assets/svg`): <https://github.com/twitter/twemoji>
- DiceBear runtime repository and package/source docs: <https://github.com/dicebear/dicebear>
- DiceBear official style definitions: <https://github.com/dicebear/styles>
- DiceBear style license overview: <https://github.com/dicebear/styles/blob/main/LICENSE.md>
- DiceBear `Shapes` definition and docs: <https://github.com/dicebear/styles/blob/main/src/shapes.json>, <https://www.dicebear.com/styles/shapes/>
- DiceBear `Cutouts` definition and docs: <https://github.com/dicebear/styles/blob/main/src/cutouts.json>, <https://www.dicebear.com/styles/cutouts/>
- DiceBear core package metadata: <https://www.npmjs.com/package/@dicebear/core>
- DiceBear style catalogue and licensing notes: <https://www.dicebear.com/styles/>
- OpenMoji repository (README, LICENSE, SVG assets): <https://github.com/hfg-gmuend/openmoji>
- Creative Commons CC0 1.0 legal text: <https://creativecommons.org/publicdomain/zero/1.0/>
- Creative Commons Attribution-ShareAlike 4.0 legal text: <https://creativecommons.org/licenses/by-sa/4.0/>
