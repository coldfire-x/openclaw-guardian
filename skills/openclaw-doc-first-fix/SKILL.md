---
name: openclaw-doc-first-fix
description: Diagnose and recommend OpenClaw gateway recovery actions by consulting live official docs at docs.openclaw.ai before suggesting any fix, and record fix history entries. Use when OpenClaw is down, doctor output is available, and the agent must classify actions as safe_fix, manual_only, or unsafe with documentation references.
---

# OpenClaw Doc-First Fixing

Follow this sequence strictly:
1. Fetch official documentation live from `https://docs.openclaw.ai/` and relevant subpages for the current diagnosis.
2. Do not cache official docs to disk or across incidents; treat each diagnosis as a fresh docs read.
3. Read local OpenClaw docs notes from `references/openclaw-docs/` as supplemental context only.
4. Read `openclaw gateway doctor` output and recent log tail.
5. Map each recommended action to documentation evidence, prioritizing official `docs.openclaw.ai` references.
6. Choose one decision: `safe_fix`, `manual_only`, or `unsafe`.
7. Prefer `manual_only` when evidence is incomplete or ambiguous.
8. Record a fix-history entry for later reference with:
   - when
   - what happened
   - fix procedure
   - evidence
   - final result

Hard constraints:
- Never approve destructive or irreversible actions.
- Never assume undocumented behavior is safe.
- Never authorize autonomous repair execution; explicit user approval is always required.

Output requirements:
- Return JSON only.
- Include fields: `decision`, `reason`, `confidence`, `recommended_actions`, `doc_references`.
- Ensure `doc_references` contains at least one official `https://docs.openclaw.ai/...` reference when decision is `safe_fix`.
