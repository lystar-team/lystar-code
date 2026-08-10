---
name: "imagegen"
description: "Generate or edit raster images with the built-in image_gen tool. Use for photos, illustrations, textures, sprites, mockups, infographics, and bitmap assets. Prefer existing SVG, HTML/CSS, canvas, or editable native assets when they fit the task better."
---

# Image Generation

> Adapted for LYStar Agent from OpenAI Codex's `imagegen` Skill. This file has been modified to use LYStar's native Tool and packaging paths.

Use the built-in `image_gen` Tool for normal image generation and editing. Do not create temporary Python or SDK scripts.

## Decide the task

- No input image: generate a new image.
- Preserve or change an existing image: edit it with `referenced_image_paths`.
- Continue from images already visible in the conversation: use `num_last_images_to_include`.
- Many distinct assets: make one Tool call per asset or prompt.
- Existing vector, logo, icon, HTML/CSS, canvas, or editable project asset: modify that native asset when generation is unnecessary.

## Prompt shape

Turn the request into a concise production specification. Keep the user's exact requirements and add only details that improve the result:

```text
Use case: <photo, product mockup, illustration, UI mockup, infographic, game asset, etc.>
Asset type: <where it will be used>
Primary request: <main request>
Input images: <each image and its role, when present>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo, illustration, 3D, pixel art, etc.>
Composition/framing: <camera, crop, placement, negative space>
Lighting/mood: <lighting and atmosphere>
Text (verbatim): "<exact visible text>"
Constraints: <must preserve or include>
Avoid: <must not appear>
```

For edits, repeat the invariants explicitly: change only the requested part and preserve identity, composition, proportions, text, or other locked details.

## Tool usage

New image:

```json
{ "prompt": "<complete prompt>" }
```

Do not request recent conversation images for a new image. If the active Provider requires values for optional schema fields, use `referenced_image_paths: []` and `num_last_images_to_include: 0`.

Edit local images:

```json
{
  "prompt": "<complete edit prompt with invariants>",
  "referenced_image_paths": ["path/to/image.png"]
}
```

Continue from recent conversation images:

```json
{
  "prompt": "<targeted follow-up change>",
  "num_last_images_to_include": 1
}
```

Use only one reference mode per call. At most five images are accepted.

## Output policy

- Generated images are saved under `~/.pi/agent/generated_images/<session>/<call>.png` and displayed automatically.
- For preview or brainstorming, the default saved file can remain there.
- For project-bound assets, copy the selected output into the workspace and update the consuming code or references.
- Do not leave a project-referenced asset only under `~/.pi/agent/generated_images`.
- Do not overwrite an existing project asset unless the user requested replacement.
- Leave the original generated file in place unless the user explicitly asks to delete it.
- Report final workspace paths and the final prompt used.

## Validation

Inspect every result before finishing:

- subject and requested style
- composition and intended crop
- exact visible text
- preserved edit invariants
- forbidden objects, logos, watermarks, or artifacts
- suitability at the final usage size

Iterate with one targeted change at a time.

## Transparent backgrounds

The native Tool currently uses the Provider's automatic background policy and does not expose a transparency parameter. Do not promise true alpha output. For a simple opaque subject, generate against a flat removable chroma-key background and remove it with existing project tools only when the user requested transparency. For hair, glass, smoke, reflections, translucent materials, or other complex edges, explain the limitation before proceeding.