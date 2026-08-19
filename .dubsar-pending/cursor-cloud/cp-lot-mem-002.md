---
{
  "base_checkpoint_sha256": "86221ea993f2bbb5968612bdf73a58ed93ef75bb12449e1400dbd82f6fe6f8ff",
  "base_work_checkpoint_sha256": "86221ea993f2bbb5968612bdf73a58ed93ef75bb12449e1400dbd82f6fe6f8ff",
  "candidate_sha256": "e5b3fa5597211607b8f2e1535ffb1a938caf27ab3619e787e8116231bc2208cd",
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
        "path": "tools/cursor-cloud/install.mjs",
        "sha256": "7f0ab70a02a31b837ad2cb5021599cfb5e349bc366c1141d86ad44a964b6f597"
      },
      {
        "path": "tools/cursor-cloud/open-session.mjs",
        "sha256": "8985281f106c729fe1dfca02c6f57af620f14146f7e682e65ae12056e37147ab"
      },
      {
        "path": "tools/cursor-cloud/record-pending.mjs",
        "sha256": "c5d23e39c643cd5508fcc6e915ca67c1418ccf2c3becbe454373d7ac5bd8a1ea"
      },
      {
        "path": "tools/cursor-cloud/runtime.mjs",
        "sha256": "f7c8e7eeebb55312171f1be499b5b17c7364e6e987caaa3ecff9306090fd9e7f"
      },
      {
        "path": "tools/cursor-cloud/contracts/LOT-MEM-002.json",
        "sha256": "10158fb2becc02b6c23db7a610076a7f6f1a717d06a47f21e17d7cc4b99cf767"
      },
      {
        "path": "tests/cursor-cloud-continuity.test.mjs",
        "sha256": "b90115ffa15aeca7ed0fea5ca52fecb7838ac4b9c87669aab4a85120e028985b"
      }
    ],
    "resolves": null,
    "resulting_state": {
      "blockers": [],
      "next_action": "Have the Cursor Cloud continuity pilot audited before any deployment to another repository.",
      "status": "active",
      "summary": "Pending Cursor Cloud candidate waits for human audit."
    },
    "summary": "Cursor Cloud session bridges, environment, and qualification tests are in this repository.",
    "validation": [
      "Install resolved packages/dubsar-project-continuity/bin/dubsar.mjs from the checkout.",
      "Session open loaded resume and route without writing .dubsar or .dubsar-pending."
    ],
    "work_id": "integrate-cursor-cloud-continuity"
  },
  "declared_source": "cursor-cloud",
  "format": "dubsar.pending-checkpoint/1",
  "project_id": "dubsar-memory",
  "source_shared_snapshot_sha256": "841da9ac82f7bb3b9c475f70f10a26196e4733c7ee2a28318be951f02015e2f9"
}
---
