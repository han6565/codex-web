# Visual explanation

Select a visual because it answers a reader's question. Start with the key answer and an orienting relationship or overview when useful; place deeper explanation beside or after the relevant visual. Do not prescribe a diagram count or force every topic into a mind map.

| Reader needs to understand | Useful forms |
| --- | --- |
| Parts, hierarchy, a conceptual framework | Labeled structure diagram, tree or a small mind map |
| Sequence, dependency or a decision | Flow diagram or step-by-step panels |
| Mechanism, cause or feedback | Causal diagram with explicit arrow meanings |
| Change over time | Timeline or comparable snapshots |
| Differences and tradeoffs | Table, aligned comparison or small multiples |
| Quantities and uncertainty | Data chart with source, units, scale and uncertainty where applicable |
| Space, appearance or an abstract analogy | Map, schematic or conceptual illustration |

Combine forms when each resolves a different difficulty. A dense mind map, large decorative cover or wall of tiny labels increases the reader's work. Split long diagrams into comprehensible units; on narrow screens stack comparisons and reflow relationships rather than shrinking an entire desktop chart until its text is unreadable.

Use controllable SVG or standard plotting tools for precise structure, labels, mathematical relationships and data. An available image-generation skill is useful for bitmap conceptual illustrations, spatial analogies or imagery that helps comprehension; use it when the task benefits, not as a mandatory step. Never present a generated illustration as a historical record, real screenshot, measurement or verified data relationship. Exact diagrams should not depend on generated lettering.

Every visual has a clear explanatory purpose, a title or caption, direct labels or a necessary legend, and a nearby textual takeaway. Distinguish observed evidence, schematic/model assumptions and generated illustration. Cite real data and preserve source dates; do not invent measurements to make a chart. Make directional arrows and causal claims explicit. Use text or shape in addition to color, readable contrast and meaningful alt text or SVG titles/descriptions.

For interaction, specify what the reader can change, what visibly changes, and what that teaches. The initial state must already communicate the key conclusion; essential answers cannot depend on discovering a hidden control. Use meaningful defaults, accessible labels, clear feedback and reset when state can be changed. Avoid controls that only change decoration.

Review the rendered result in this order:

1. **Newcomer:** Is the main answer clear without clicking? Does each visual explain a relationship the prose alone makes hard to grasp?
2. **Design:** Are labels legible on a phone, grouped logically, and close to their explanation? Is the report still comfortable to read as prose?
3. **QA:** Inspect the actual reader rendering after cleanup; check images, SVG labels, formulas, headings and navigation. For web, use real controls, verify change and reset, and check console errors. Test desktop and narrow mobile widths for clipping or page-wide horizontal overflow. Viewport emulation does not establish real iOS Safari compatibility.
