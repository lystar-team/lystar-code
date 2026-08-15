# Third-Party Licenses

LYStar Code is based on Pi and distributes Pi under the MIT License. The full Pi license is included as `LICENSE`.

The standalone bundles also include runtime assets or native modules from these direct dependencies:

| Package | License |
|---|---|
| `@earendil-works/pi-ai` | MIT |
| `@earendil-works/pi-agent-core` | MIT |
| `@earendil-works/pi-tui` | MIT |
| `@mariozechner/clipboard` and platform bindings | MIT |
| `@silvia-odwyer/photon-node` | Apache-2.0 |
| OpenAI Codex `imagegen` Skill (adapted) | Apache-2.0 |
| `@xterm/xterm` and `@xterm/addon-fit` | MIT |
| `chalk` | MIT |
| `diff` | BSD-3-Clause |
| `highlight.js` | BSD-3-Clause |
| `jiti` | MIT |
| `semver` | ISC |
| `undici` | MIT |
| `yaml` | ISC |
| Noto Sans CJK | SIL Open Font License 1.1 |
| Microsoft WebView2 SDK loader | Microsoft Software License Terms |
| Ratatui `0.30.2` | MIT |
| Crossterm `0.29.0` | MIT |
| Ciborium `0.2.2` | Apache-2.0 |
| Typify `0.7.0` | Apache-2.0 |
| Serde / serde_json / thiserror / regress / unicode-segmentation / unicode-width | MIT OR Apache-2.0 |
| signal-hook `0.3.18` | Apache-2.0 OR MIT |

`package-lock.json` is the authoritative dependency inventory for the source tree. Release automation must regenerate this file when dependencies change and must review license changes before publishing a bundle.

Grok Build is used only as an interaction reference. No Grok Build source code or assets are distributed in LYStar Code.
