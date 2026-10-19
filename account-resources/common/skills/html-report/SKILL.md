---
name: html-report
description: Create reader-focused visual reports, research summaries, substantial explanations, and interactive explainers as one self-contained UTF-8 HTML file. Use when sustained reading or exploration benefits from a webpage; simple facts and narrow clarifications can stay in chat. Respect an explicitly requested format.
---

# HTML Report

Choose the presentation by what helps the reader understand the question, not by topic keywords or word count. Honor an explicitly requested format, destination, or brevity.

## Choose the output

- Answer facts, narrow follow-ups (including academic clarifications), short procedures, and status results directly in chat when that is sufficient. Do not manufacture an attachment for every question.
- For a report, substantial explanation, research synthesis, historical development, or multi-factor comparison that needs sustained reading, prefer one illustrated HTML document, normally `reader`. Lead with the answer and overall relationships, then develop the details. Look actively for diagrams that remove explanatory effort; HTML should add more than a wrapper around prose.
- When changing a parameter, stepping through a mechanism, comparing scenarios, or exploring relationships materially improves understanding, use one self-contained interactive HTML (`web`). Complexity alone is not a reason for interaction. Static disclosure such as `<details>` does not by itself require scripts or web mode. A report and its useful demonstration can share one webpage; do not mechanically create two deliverables.
- Read [references/visual-explanation.md](references/visual-explanation.md) to choose and review visuals. For `web`, also read [references/interactive-web.md](references/interactive-web.md); the static restrictions and validator below apply to `reader` only.

## Reader workflow

1. Read [references/style-guide.md](references/style-guide.md) before designing the report.
2. Start from [assets/report-template.html](assets/report-template.html). Keep its document shell, responsive reading card, anchor IDs, and numbering CSS unless the subject genuinely needs a documented variation. The Codex Web reader derives the outer directory from the body and renders the sanitized body in the same page; do not embed a duplicate desktop/mobile directory in each report.
3. Put final files in the conversation output directory supplied by Codex Web. Keep research notes, charts, and intermediate assets in the job runtime directory.
4. Embed necessary CSS, SVG, charts, and images. Do not depend on JavaScript, CDNs, remote fonts, stylesheets, or remote media. Ordinary citation hyperlinks may remain external. The Codex Web reader may strip active/embed elements before previewing a report.
5. Give every `h2` and `h3` a stable, unique `id`. The template's CSS supplies Chinese section numbers (`一、`, `二、` and `1.1`) automatically; do not type duplicate numbers into heading text. The surrounding Codex Web reader shows an outer directory only when there are at least two `h2` sections, and lists `h2` only.
6. Use semantic headings: exactly one `h1`, then `h2` for major sections and `h3` for subsections. Use `<ol>` for genuinely ordered procedures and `<ul>` for unordered points; do not add artificial numbers to ordinary prose paragraphs.
7. Run `scripts/validate_report.py <report.html>` and fix every reported error before delivery.

## Reader quality bar

- Declare UTF-8 with `<meta charset="utf-8">` and include a responsive viewport.
- Use semantic headings and exactly one clear `h1`; lead with conclusions and preserve source dates, evidence, and uncertainty.
- Keep the report itself as one restrained reading card. The Codex Web preview/share shell supplies the sticky desktop TOC card, the mobile drawer, the three-line top-bar toggle, compact numbered entries, selected/focus state, and anchor navigation. The report must remain readable with scripts disabled and when downloaded standalone.
- Use a flat, solid-color visual system. Do not use CSS gradients, glassmorphism, glow effects, decorative background art, or oversized hero blocks. Create hierarchy with typography, spacing, restrained borders, and at most a few purposeful solid fills.
- Keep the layout simple, professional, and information-first. Use cards, badges, metric tiles, and multi-column sections only when they make a real comparison or grouping easier to understand.
- Optimize for long-form reading on desktop and mobile. Allow comparison grids only when they clarify genuine relationships, and collapse them to one column on narrow screens.
- Include accessible labels, alt text, units, legends, and textual takeaways for visual evidence.
- Keep reader reports static and independent after download. Never add a duplicate file toolbar inside the document; Codex Web supplies its own viewer controls.
- The 阅读器外壳 supplies light/dark/system appearance. Logged-in readers reuse the Codex Web account preference; public guest readers keep a separate local preference. Do not hard-code the report to a single system color scheme.

## Delivery review (both modes)

- Validate the actual presentation, not only the source: inspect the reader's cleaned rendering or operate the web controls at desktop and mobile sizes. Review first for a newcomer's understanding, then layout and labels, then functionality. Say which checks could not be run; a static validator alone cannot establish visual quality.
- Link only the final deliverable in the reply, using Codex Web's delivery rules. Do not create a second Markdown copy unless explicitly requested. For web, put external source citations in the final chat as required by its sandbox protocol.
