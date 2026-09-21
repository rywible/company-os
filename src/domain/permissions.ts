import { z } from "zod";
import type { Lens } from "./discovery";
import type { AgentResult, CompanyState, Run } from "./model";
import { DomainError } from "./errors";
export const permissionSchema = z.enum([
  "evidence",
  "knowledge",
  "milestones",
  "investigate",
]);
export type AutomationPermission = z.infer<typeof permissionSchema>;
export const permissionLabels: Record<AutomationPermission, string> = {
  evidence: "Add intake",
  knowledge: "Create and update knowledge",
  milestones: "Propose milestones",
  investigate: "Investigate and develop recommendations",
};
export function automationPermissions(
  task: Pick<Lens, "kind" | "permissions">,
): AutomationPermission[] {
  return (
    task.permissions ||
    (task.kind === "knowledge"
      ? ["knowledge"]
      : task.kind === "planning"
        ? ["milestones"]
        : task.kind === "task"
          ? ["evidence"]
          : ["evidence", "investigate"])
  );
}
// A run cannot gain authority from a later edit. Revocations take effect before
// results are applied, including results already in flight.
export function assertAutomationOutput(
  state: CompanyState,
  run: Run,
  output: AgentResult,
) {
  if (!run.automationPermissions) return;
  const task = state.discovery.lenses.find((t) => t.id === run.discoveryLensId);
  const current = task ? automationPermissions(task) : [];
  const allowed = (p: AutomationPermission) =>
    run.automationPermissions!.includes(p) && current.includes(p);
  const require = (p: AutomationPermission, present: boolean) => {
    if (present && !allowed(p))
      throw new DomainError(
        "This automation is not allowed to " +
          permissionLabels[p].toLowerCase() +
          ".",
      );
  };
  require("evidence", !!output.observations.length);
  require("knowledge", !!output.libraryUpdates?.length || !!output.documentEdits?.length || !!output.intakeResolutions?.length);
  require("milestones", !!output.milestones?.length);
  if (
    output.milestones?.length &&
    task &&
    state.planning.milestones.filter(
      (m) => !["completed", "declined"].includes(m.status),
    ).length +
      output.milestones.length >
      (task.targetMilestones || 2)
  )
    throw new DomainError(
      "This automation would exceed its upcoming milestone limit.",
    );
  require("investigate", !!output.discoveries.length ||
    !!output.discoveryAssessment ||
    !!output.discoveryOutcome);
  if (
    (output.work.length && !run.context?.discovery) ||
    output.changes.length ||
    output.proposals.length ||
    output.milestoneRevisions?.length
  )
    throw new DomainError(
      "Automations cannot execute arbitrary work, change governing documents, or revise approved authority.",
    );
}
