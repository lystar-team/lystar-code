# Third-Party Licenses

LYStar Agent is based on Pi and distributes Pi under the MIT License. The full Pi license is included as `LICENSE`.

The standalone bundles also include runtime assets or native modules from these direct dependencies:

| Package | License |
|---|---|
| `@earendil-works/pi-ai` | MIT |
| `@earendil-works/pi-agent-core` | MIT |
| `@earendil-works/pi-tui` | MIT |
| `@mariozechner/clipboard` and platform bindings | MIT |
| `@silvia-odwyer/photon-node` | Apache-2.0 |
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

`package-lock.json` is the authoritative dependency inventory for the source tree. Release automation must regenerate this file when dependencies change and must review license changes before publishing a bundle.

Grok Build is used only as an interaction reference. No Grok Build source code or assets are distributed in LYStar Agent.
