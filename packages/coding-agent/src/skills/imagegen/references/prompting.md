# Prompting Guide

Turn the request into a concise production specification. Keep the user's exact requirements and add only details that improve control.

## Recommended shape

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

Omit fields that do not help the request. Do not fill the prompt with ornamental adjectives that change the user's intent.

## Edits and references

For each reference image, describe its role:

- base image to edit;
- identity or product reference;
- style reference only;
- composition reference;
- material, color, or texture reference.

State edit invariants explicitly. Example:

```text
Change only the jacket color to deep navy. Preserve the person's face, hairstyle, pose, body proportions, camera angle, crop, background, lighting, and all visible text. Do not add accessories.
```

Use precision profile when failure to preserve an invariant would make the result unusable.

## Exact text

- Put every visible string in quotation marks.
- Preserve capitalization, punctuation, spacing, and language.
- State the text hierarchy and placement.
- Request readable typography at the intended output size.
- Use precision profile for dense text, labels, packaging, posters, or interface mockups.

## Iteration

After inspecting a result, revise one variable at a time: crop, color, lighting, layout, expression, or one locked detail. Keep successful parts listed as invariants. Use a new Tool call for a distinct asset instead of combining unrelated outputs in one prompt.
