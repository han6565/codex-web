# Interactive explanation in Codex Web

Use this mode when operating a model or comparing states makes the explanation easier to understand. Keep useful prose and diagrams in the same document. Reuse the restrained typography and responsive principles of [style-guide.md](style-guide.md), but its prohibition on scripts and reader-only cleanup rules do not apply to web. Do not run the static `validate_report.py` as if it validated interactive pages.

## Delivery contract

The installed runtime's delivery instructions are authoritative. The current protocol is documented in the Codex Web engineering document `docs/WEB_PRESENTATIONS.md` when that source tree is accessible. The following authoring checklist supports generating the document without access to that repository:

- Write a single UTF-8 `.html`, at most 5 MiB, to `CWW_OUTPUTS_DIR`. Include charset and viewport metadata. Embed all scripts, CSS, images, fonts, audio/video and data; no external or relative resources, iframes, remote form submissions or redirects.
- Beside the final HTML write `<filename>.html.pp-agent.json` with `{"presentation_mode":"web","sha256":"<complete lowercase SHA-256 of final HTML bytes>"}`. Compute the hash after the final edit. A `pp-agent-view` meta hint alone cannot grant execution. The sidecar is protocol material, not a user attachment link.
- `a`/`area` `href` values can only be `#` page anchors. Put external source links in the final chat, with enough citation labels in the page to identify them. Separate downloadable files use attachment cards, not relative links from the page.
- The page runs in an opaque-origin sandbox with scripts, without backend, login, network requests, external APIs, parent DOM access, localStorage or persistent state. All interaction state is in memory for the current page. Do not promise saving or capabilities outside this boundary.
- If the task needs a small text export, use `window.ppAgent.exportFile('result.json', JSON.stringify(data))` only on a user click; the platform confirms the download. Supported filenames end in json/csv/txt and the UTF-8 payload is at most 1 MiB. Do not offer export outside that supported runtime without a tested fallback.

The platform validates the declaration and content before granting web mode. Missing declarations remain reader; invalid web declarations/content can be delivered as reader with a warning, in which scripts will not run. That fallback is not successful interactive delivery.

## Verify the explanation

Show the core answer and meaningful default state on first load. Label controls by the concept they change, show current values and outcome feedback, and give an accessible reset for adjustable state. Avoid embedding implementation details in the reader's flow.

Check the final bytes and matching hash, actual web presentation, real control changes, reset and visible feedback, keyboard use, desktop/mobile layout and script errors. Verify the rendered diagram remains consistent with the current state. Keep navigation local and the page understandable without completing a sequence of clicks. The reader validator is intentionally static; web acceptance needs browser operation inside the real sandbox.
