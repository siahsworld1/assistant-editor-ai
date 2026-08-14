# Assistant Editor AI — Premiere Pro UXP panel (v0.4.0)

This folder is the plugin **source**. `npm run premiere:prepare` copies it into
`dist-premiere/ai.assistanteditor.premiere/` as a clean, loadable UXP package.

## Load in Premiere (development)

1. Start Assistant Editor Desktop (`npm run dev:desktop`, or a packaged build).
   It opens the Premiere bridge on `http://127.0.0.1:32146`.
2. Install Adobe's **UXP Developer Tool** (from the Creative Cloud desktop app).
3. Run `npm run premiere:prepare` in this repo.
4. UDT → *Add Plugin* → select `dist-premiere/ai.assistanteditor.premiere/manifest.json`.
5. Launch Premiere Pro 25+, then UDT → *Load*.
6. Premiere → *Window → Extensions (or Plugins) → Assistant Editor AI*.

## What works today

- Handshake, protocol/version negotiation, diagnostics, live desktop status.
- Active project read, project item listing, sequence-name listing (host permitting).
- Analyze Footage / Send Selection / Open Assistant Editor messages.

## Capability-gated (host validation required)

`sequence.create`, `clip.insert`, `broll.insert`, `markers.write`, `labels.write`,
detailed `selection.read` and media path metadata report **false** and throw
`NotImplementedInHost`. They must be validated inside a real Premiere UXP host
before being enabled in `src/adapter.js`.

## Not done

No Adobe signing, no `.ccx` bundle, no Marketplace submission. See the root
README section “Premiere Pro Integration (v0.4.0)”.