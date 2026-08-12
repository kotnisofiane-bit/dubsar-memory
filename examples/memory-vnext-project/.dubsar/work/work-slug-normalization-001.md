---
{
  "acceptance_criteria": [
    "Accents and punctuation normalize to lowercase ASCII slugs.",
    "An input with no letters or digits is rejected.",
    "The focused test suite passes."
  ],
  "format": "dubsar.work/1",
  "knowledge_ids": [
    "knowledge-slug-contract-001"
  ],
  "objective": "Harden slug normalization without introducing locale-dependent output.",
  "references": [
    "src/slug.mjs",
    "test/slug.test.mjs"
  ],
  "scope": "multi_step",
  "status": "open",
  "title": "Harden slug normalization",
  "work_id": "work-slug-normalization-001"
}
---
# Harden slug normalization

Keep implementation notes here as advisory data.
