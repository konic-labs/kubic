# Example system prompt addition.
# The `[agent] systemPromptFile` key in the sibling `example.toml` points
# here: a relative path resolves against the declaring config file's
# directory, so this file augments the lane prompt wherever the example is
# copied. Keep it short — it lands ahead of the skills block on every run.
Prefer short, technical answers. Name files by their repo-relative path.
