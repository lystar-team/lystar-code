---
name: "imagegen"
description: "Generate or edit raster images with the built-in image_gen tool. Use for photos, illustrations, textures, sprites, mockups, infographics, and bitmap assets. Prefer existing SVG, HTML/CSS, canvas, or editable native assets when they fit the task better."
---

# Image Generation

Use the built-in `image_gen` Tool for normal image generation and editing. The user describes the visual outcome in natural language; convert that request into a complete prompt and structured model intent. Do not make the user write Tool JSON. Do not create temporary SDK scripts while the native Tool can perform the task.

## Decide the task

- No input image: generate a new image.
- Preserve or change an existing image: edit it with `referenced_image_paths`.
- Continue from images already visible in the conversation: use `num_last_images_to_include`.
- Many distinct assets: make one Tool call per asset or prompt.
- Existing vector, logo, icon, HTML/CSS, canvas, or editable project asset: modify that native asset when generation is unnecessary.

Read [references/model-selection.md](references/model-selection.md) before choosing `model` or `profile`. Read [references/prompting.md](references/prompting.md) when the request needs exact text, layout, identity preservation, multiple references, or production-level prompt detail.

## Model intent

Use structured arguments instead of prompt keyword matching:

- Normal new images, concepts, drafts, variations, style exploration: `model: "auto", profile: "standard"`.
- Fast ideation or repeated rough iterations: `model: "auto", profile: "fast"`.
- Precise edits, locked identity or product details, exact text/layout, complex compositing, highest fidelity: `model: "auto", profile: "precision"`.
- If the user names Flare, Sunburst, or GPT Image 2, pass that exact model.
- Treat the phrase “GPT Image 2.5” as a family request, not an API model ID. Choose Flare or Sunburst from the task semantics.
- Never pass bare `gpt-image-2.5`.

## Tool usage

New image:

```json
{
  "prompt": "<complete prompt>",
  "model": "auto",
  "profile": "standard"
}
```

Edit local images:

```json
{
  "prompt": "<complete edit prompt with invariants>",
  "model": "auto",
  "profile": "precision",
  "referenced_image_paths": ["path/to/image.png"]
}
```

Continue from recent conversation images:

```json
{
  "prompt": "<targeted follow-up change>",
  "model": "auto",
  "profile": "precision",
  "num_last_images_to_include": 1
}
```

Use only one reference mode per call. At most five images are accepted. For a new image, omit reference fields; if all schema fields must be present, use `referenced_image_paths: []` and `num_last_images_to_include: 0`.

## Prompt rules

- Preserve the user's requested content, style, framing, dimensions, visible text, and exclusions.
- Add production details only when they clarify the requested result.
- Put exact visible text in quotation marks and spell it exactly.
- For edits, state what changes and what must remain invariant.
- Give each reference image one clear role.
- Do not ask follow-up questions when a reasonable production choice can be made from context.

## Output policy

- Generated images are saved under `~/.pi/agent/generated_images/<session>/<call>.<ext>` and displayed in the image-generation card.
- For preview or brainstorming, the generated file can remain there.
- For project-bound assets, copy the selected output into the workspace and update the consuming code or references.
- Do not leave a project-referenced asset only under `~/.pi/agent/generated_images`.
- Do not overwrite an existing project asset unless the user requested replacement.
- Leave the original generated file in place unless the user explicitly asks to delete it.
- Report final workspace paths and the final prompt used.

## Validation

Inspect every result before finishing:

- subject, style, composition, crop, and intended usage
- exact visible text and layout
- preserved edit invariants and reference roles
- forbidden objects, logos, watermarks, and artifacts
- suitability at the final display size

Iterate with one targeted change at a time. Use Flare for ordinary revisions; switch an automatic task to precision when the revision depends on locked details rather than broad visual direction.

## Transparent backgrounds

The native Tool uses the Provider's automatic background policy and does not expose a transparency parameter. Do not promise true alpha output. For a simple opaque subject, generate against a flat removable chroma-key background and remove it with existing project tools only when the user requested transparency. For hair, glass, smoke, reflections, translucent materials, or other complex edges, explain the limitation before proceeding.
