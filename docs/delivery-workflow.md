# Milestone delivery

Human approval fixes the outcome, boundaries, total agent-run allowance, review count and delivery policy. Agent roles determine capability and execution profiles. Foreman cannot approve its own milestones or change active boundaries. All retries, reviews, adjudication, acceptance and acceptance fixes charge the original milestone's allowance.

Implementation assignments receive server-generated `codex/milestone-<id>-work-<id>` branches from the current `codex/milestone-<id>` root after their dependencies have merged. Source changes are verified before publication. Creating the assignment PR emits the durable event that starts review. A PR completes implementation; only reviewed integration completes the assignment and releases descendants.

## Review limits

Two independent reviewers and two correction rounds are the defaults. Reviewers return a structured ledger: stable ID, severity, defect category, concrete evidence, verification procedure, and open/resolved/dismissed status. Style and suggestions cannot block. Every later reviewer must explicitly account for prior blockers; the prompt restricts new blockers to material defects and regressions. Materiality remains model judgment, bounded by adjudication and hard attempt limits.

After the correction allowance, the Adjudicator role sees the requirements, exact diff, previous results, findings, and history. It may accept sufficient fixes, dismiss unsupported blockers, or prescribe one final correction. A separate verification by that role checks the final correction. Failure defers the assignment and its descendants; independent streams continue. No automatic replacement assignment resets a stopped review budget. Foreman discussions concern changed outcome, scope, or authority, not human PR review.

Publication is pinned to the reviewed commit. Replayed events cannot add another quorum, correction or PR. Saved pending outputs make publication retries reuse the original execution identity. GitHub comments carry idempotency markers. Polling detects missed head updates. Reviews are separate model runs using one GitHub identity, so they do not fulfill rules requiring approvals from distinct GitHub accounts.

## Integration and acceptance

Engineering checks are separate from whole-milestone acceptance, so shared interfaces can merge before dependent features exist. Both sets of commands are user-owned settings and execute without a shell in clean Sprite checkouts. Company acceptance supplies the default; an optional project policy replaces it. For games, configure a real playtest command that exercises the playable build and reports its results. This does not invent a game-specific playtest harness.

The adapter creates a merge candidate from the current target and reviewed head. It verifies that exact candidate, then updates the target to that commit with `force: false`. A concurrent divergent update rejects the fast-forward and requires a freshly tested candidate. Assignment integration has at most three candidate retries. The implementation uses GitHub's [branch merge API](https://docs.github.com/en/rest/branches/branches) and [non-force reference updates](https://docs.github.com/en/rest/git/refs); repository protection rules still apply, and insufficient connector permissions surface as workflow failures rather than being bypassed.

After all assignments merge, the system opens the milestone PR to main and runs configured acceptance checks against its integration candidate. An Acceptance tester evaluates criteria, integrated source, and recorded results. A model approval cannot override failing checks. A failure creates one bounded corrective assignment by default, then repeats acceptance; the default is two acceptance attempts total. Exhaustion pauses the milestone. Main advances only to the accepted candidate. Deployment is not part of this policy.

Knowledge-only milestones use the independent acceptance role to evaluate their artifacts without creating empty code PRs. Old approved milestones retain their prior completion semantics; new approvals receive delivery-policy snapshots. Changing policy applies to subsequent approvals. Disabling engineering changes or automatic merging revokes those capabilities for active work too.

## Current execution boundary

Engineering supports complete replacement text files under `src`, `tests`, `e2e`, and `docs`, with TypeScript, CSS, Markdown, JSON, GLSL, GDScript and C# extensions. It does not grant dependency, root configuration, workflow, binary asset, deletion or deployment authority. Unsupported operations must be reported explicitly. Verification checkouts are bounded by file/context limits and are not a new general-purpose coding harness. Acceptance logs are retained in milestone state; large binary playtest artifacts need a project-owned artifact location reported by the configured check.
