---
{
  "base_checkpoint_sha256": "86221ea993f2bbb5968612bdf73a58ed93ef75bb12449e1400dbd82f6fe6f8ff",
  "base_work_checkpoint_sha256": "86221ea993f2bbb5968612bdf73a58ed93ef75bb12449e1400dbd82f6fe6f8ff",
  "candidate_sha256": "af4091e10ce0dc708e79156f2ab7429c6da75018ad8c901419a1458f20990c78",
  "checkpoint": {
    "attempt": null,
    "checkpoint_id": "cp-lot-mem-002",
    "kind": "progress",
    "limitations": [
      "The candidate is not promoted and grants no merge or deployment authority.",
      "This pilot has not been copied to another repository."
    ],
    "references": [
      {
        "path": ".cursor/environment.json",
        "sha256": "ecc8c35c86efe1ac47cf035f2e9f3fe2f36980fd7e84ac7bb3024a4935abb1f6"
      },
      {
        "path": ".cursor/rules/dubsar-memory-cursor-cloud.mdc",
        "sha256": "cc3bcc215ffaaea18e4c253be2ed3df5fe7dedac98f5f74a5cb8b652efe2ecc5"
      },
      {
        "path": "tools/cursor-cloud/record-pending.mjs",
        "sha256": "c5d23e39c643cd5508fcc6e915ca67c1418ccf2c3becbe454373d7ac5bd8a1ea"
      },
      {
        "path": "tools/cursor-cloud/runtime.mjs",
        "sha256": "59a1fa02f323c781cff0bfa48da2913b029cc22c86e01ee8e4b77a28a66f7f13"
      },
      {
        "path": "tools/cursor-cloud/qualify.mjs",
        "sha256": "a66cdce9e420ede11a576c6c99cc8c2308e4aa285be86b159f3c841ba36fb34c"
      },
      {
        "path": "tools/cursor-cloud/verify-candidate-references.mjs",
        "sha256": "56a22ded46db7072b99a7f9ba8b880ec92810514e29a22b5c05428526916435b"
      },
      {
        "path": "tools/cursor-cloud/contracts/LOT-MEM-002.json",
        "sha256": "10158fb2becc02b6c23db7a610076a7f6f1a717d06a47f21e17d7cc4b99cf767"
      },
      {
        "path": "tests/cursor-cloud-continuity.test.mjs",
        "sha256": "072cc3507311835b8e2cc111cab36587fa4169898901d108d77ec99fadeb9e16"
      }
    ],
    "resolves": null,
    "resulting_state": {
      "blockers": [],
      "next_action": "Have the Cursor Cloud continuity pilot audited before any deployment to another repository.",
      "status": "active",
      "summary": "Pending Cursor Cloud candidate waits for human audit."
    },
    "summary": "Cursor Cloud continuity with verified pending candidate references.",
    "validation": [
      "Install resolved packages/dubsar-project-continuity/bin/dubsar.mjs from the checkout.",
      "Session open loaded resume and route without writing .dubsar or .dubsar-pending.",
      "Qualification verifies every recorded candidate reference against the current checkout."
    ],
    "work_id": "integrate-cursor-cloud-continuity"
  },
  "declared_source": "cursor-cloud",
  "format": "dubsar.pending-checkpoint/1",
  "project_id": "dubsar-memory",
  "source_shared_snapshot_sha256": "841da9ac82f7bb3b9c475f70f10a26196e4733c7ee2a28318be951f02015e2f9"
}
---
