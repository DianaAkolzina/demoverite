---
category: rag
tags: best-practices,metadata,chunking
summary: Guidelines for feeding retrieval with high-signal knowledge
---

# RAG Best Practices For This Repo

When you add reference material under `knowledge/`, keep these guardrails in mind so retrieval stays precise:

1. **Front matter metadata**
   - Use the YAML header (see this file) to set `category`, `tags`, and `summary`.
   - Set `exclude: true` or `status: deprecated` to remove a document from the index automatically.
   - Use `flagged: true` on drafts that should never reach production responses.

2. **Contextual chunking**
   - Organise long docs with headings; the indexer keeps headings with their sections and merges tiny sections automatically so chunks are neither too small (no context) nor too large.
   - Keep individual sections below ~1.2k characters so they map cleanly to a single vector/TFiDF slice.

3. **Late chunking for tables/code**
   - When embedding large tables, repeat the column names near the relevant rows so each chunk still contains the schema context the agent needs.

4. **Metadata filtering & validation**
   - Retrieval now drops documents marked as deprecated/flagged and rejects hits whose lexical/semantic score is too low. Keep summaries/tags accurate so the filter makes the right call.

5. **Regression prompts**
   - For complex workflows (schema alignment, energy↔IAQ, device health), pair every doc addition with a regression prompt in `knowledge/regressions.md`. This keeps the agent’s planning “muscle memory” aligned with the helper tooling.

The TL;DR: always label your docs, favour well-structured sections, and use the regression prompts to prove retrieval brought the right context into the LLM’s plan.
