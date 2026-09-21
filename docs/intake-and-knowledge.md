# Intake and Knowledge

Intake is a temporary loading dock. Knowledge is the maintained library. Intake uses the `intake` document level and its own lifecycle metadata; it is keyword-searchable in the Intake view but excluded from ordinary agent retrieval. Explicit attachments and assignment reviewers can receive it as uncurated material.

The existing Knowledge screen keeps its Library tab. The former Evidence tab is now Intake, with create, edit, readiness and permanent-delete controls. Knowledge readers have a collapsible section outline; revision history and pending proposals expose text differences. Assignments awaiting curation display “Updating Knowledge.”

## Automatic curation

1. Human drafts remain collecting until marked ready. Completed non-milestone findings become ready automatically. Milestone research produces collecting intake and an independent reviewer must approve the exact supplied revisions before they become ready. Legacy worker `libraryUpdates` are captured as intake, never published directly.
2. `IntakeReady` durably requests Foreman curation using the Knowledge library automation's model, permissions and allowance. Concurrent events coalesce behind one queued/running pass. Pause and daily allowance still apply; the scheduler recovers pending work when capacity returns.
3. Foreman receives a bounded batch, relevant subjects, and a catalog with headings. Each supplied intake item requires an explicit incorporate, discard or defer resolution. Incorporated material must identify the associated Knowledge updates. Uncertainty, negative results, limitations and useful external references belong in those updates.
4. Validated updates and permanent intake deletion commit together. Pending human approvals retain the intake. Acceptance completes the batch; dismissal returns it to collecting. Failed, incomplete, stale or deferred passes retain their inputs. Large intake is processed in bounded slices and is deleted only after the final slice.
5. Curated pages retain useful citations instead of depending on deleted intake IDs. Migration also detaches old page citations from disposable notes. The receipt records IDs, time and outcome, never a copy of the intake body. Intake documents, revision rows and search entries are physically deleted. Existing historical execution records and external worker logs retain their normal diagnostic lifecycle; deleting intake is not an erasure of all historical runs or backups.
6. Reviewed research assignments wait for their intake to be incorporated or deliberately discarded before downstream work and milestone acceptance proceed. Each assignment receives only the subjects associated with its own intake resolutions.

Migration 3 preserves existing document IDs and human Knowledge pages, converts raw machine notes to Intake, and queues eligible material. Existing library pages keep their revisions and organization. Newly curated full documents use the structured format; existing pages can be converted during curation. Do not downgrade to an application predating migration 3 against the migrated database.

## Knowledge structure

A curated subject has a stable ID, title, summary, scope, aliases, collection, optional parent and related subjects, citations, revision, and review metadata. Markdown format 1 contains these exact level-two sections in order:

1. Overview
2. Current understanding
3. Constraints and assumptions
4. Decisions and implications
5. Open questions
6. References

Each section contains substantive material or an explicit statement that nothing is known or decided. Detail is organized into level-three and deeper subsections with unique heading paths. External citations belong beside the claims they support and in References. A research finding does not establish a company decision. Existing human-edit and direction-change approval rules remain enforced.

## Targeted document edits

`documentEdits` supplements `libraryUpdates`. An edit specifies a document ID, exact expected revision, reason, supplied evidence, approval flag, operations, and optional explicit source additions/removals. Existing metadata and sources are preserved automatically. Full replacements of existing subjects require `replaceWholeDocument: true` and a complete supplied page.

Supported operations are `replace_section` (replace the body beneath an exact heading path), `insert_after_section`, `append_section` (empty path for the root), `delete_section`, `move_section` (reorder siblings), and `replace_text` (exactly one occurrence). Heading discovery ignores fenced code. Missing, duplicate, stale or unseen anchors fail atomically. Destructive section operations require the entire original target section to have been supplied. The resulting Markdown is validated and saved as a normal revision, or held as a proposal under the existing approval rules.

Storage, output and briefing limits are independent:

- Stored document: 500,000 characters.
- Model-generated replacement or individual patch text: 80,000 characters; an output reaching that exact boundary is rejected so a smaller edit can be requested.
- Selected document content: normally 16,000 characters per page within the existing 60,000-character Knowledge allocation.
- Intake briefing: 60,000 characters total, with at most 40,000 from one intake entry per pass.

Large Knowledge pages provide a heading outline and selected sections, clearly marked partial. Semantic search passages and the current query guide section selection. Supplemental requests may specify a page title and heading path. Partial pages cannot authorize full replacements; targeted edits can change visible text and complete supplied sections. Index chunks carry the page title and section path. JSON/schema validation and unfinished-code-block checks detect known incomplete output; there is no claim of detecting every semantically unfinished sentence.
