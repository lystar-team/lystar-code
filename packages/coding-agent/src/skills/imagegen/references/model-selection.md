# Model Selection

The Agent decides semantic intent. The Tool performs deterministic mapping and Provider fallback. Do not inspect the prompt with keyword regular expressions at runtime.

## Selection matrix

| User or task intent | Tool arguments | Primary model |
| --- | --- | --- |
| Ordinary generation, concept art, draft, multiple compositions, style exploration | `model: "auto", profile: "standard"` | `gpt-image-2.5-flare` |
| Fast rough iteration | `model: "auto", profile: "fast"` | `gpt-image-2.5-flare` |
| Precise local edit, identity/product consistency, exact typography/layout, multi-reference composition, highest fidelity | `model: "auto", profile: "precision"` | `gpt-image-2.5-sunburst` |
| User explicitly requests Flare | `model: "gpt-image-2.5-flare"` | Flare |
| User explicitly requests Sunburst | `model: "gpt-image-2.5-sunburst"` | Sunburst |
| User explicitly requests GPT Image 2 | `model: "gpt-image-2"` | GPT Image 2 |

If the user says only “GPT Image 2.5”, treat it as a family alias:

- choose Flare for ordinary generation, drafts, variations, and broad style work;
- choose Sunburst for precision-sensitive edits, locked content, complex text/layout, or explicit maximum fidelity.

There is no bare `gpt-image-2.5` Tool/API model. Never send that value.

## Fallback rules

- Explicit model: try other configured Providers that expose the same model. Never change the model silently.
- Automatic Flare or Sunburst: try configured Providers for that model first; if none succeeds, GPT Image 2 is the compatibility fallback.
- Content-policy and safety failures stop immediately. Do not route around them through another Provider or model.
- OpenAI Codex OAuth is used only for its registered GPT Image 2 capability.

The Provider order is deterministic: active compatible Provider, OpenAI Codex, OpenAI API, then OpenRouter. The active compatible Provider keeps its resolved API key, headers, environment, and base URL.
