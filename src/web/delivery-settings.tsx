import React, { useState } from "react";
import type { Settings } from "../domain/model";
import type { AcceptancePolicy } from "../domain/delivery";
import type { CommandHandler } from "./settings";

export function DeliverySettings({
  settings,
  disabled,
  command,
}: {
  settings: Settings;
  disabled: boolean;
  command: CommandHandler;
}) {
  const [policy, setPolicy] = useState(settings.delivery);
  const [count, setCount] = useState(settings.requiredReviews);
  const [allow, setAllow] = useState(settings.allowCodeChanges);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="preference-section editor"
      style={{ maxWidth: "48rem" }}
      onChange={() => setSaved(false)}
      onSubmit={(e) => {
        e.preventDefault();
        void command({
          type: "ConfigureDelivery",
          policy,
          requiredReviews: count,
          allowCodeChanges: allow,
        }).then(setSaved);
      }}
    >
      <div>
        <h2>Review and delivery</h2>
        <p className="muted">
          Agents review, correct, and test approved work. Your Inbox is for
          decisions about outcomes and authority.
        </p>
      </div>
      <label>
        Required independent reviews
        <input
          type="number"
          min={1}
          max={5}
          required
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <label>
        Correction rounds before adjudication
        <input
          type="number"
          min={0}
          max={3}
          required
          value={policy.correctionRounds}
          onChange={(e) =>
            setPolicy({ ...policy, correctionRounds: Number(e.target.value) })
          }
        />
      </label>
      <p className="field-help">
        Unresolved findings go to the Adjudicator role, with at most one final
        correction. Preferences never block a merge. Exhausted attempts stop
        within the milestone’s total run allowance.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={allow}
          onChange={(e) => setAllow(e.target.checked)}
        />
        Let agents implement approved work and fix review findings
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={policy.autoMerge}
          onChange={(e) =>
            setPolicy({ ...policy, autoMerge: e.target.checked })
          }
        />
        Automatically merge accepted work
      </label>
      <p className="field-help">
        Assignment PRs merge into their milestone. The milestone reaches main
        only after integrated acceptance passes. Deployment is separate.
      </p>
      <details className="preference-note">
        <summary>Engineering verification</summary>
        <p className="field-help">
          These checks validate each assignment before publication and
          integration. Keep full milestone scenarios in acceptance so shared
          interfaces can unblock downstream work.
        </p>
        <AcceptanceFields
          label="Engineering"
          value={{
            instructions: "Verify each assignment before integration.",
            checks: policy.verificationChecks,
          }}
          onChange={(value) =>
            setPolicy({ ...policy, verificationChecks: value.checks })
          }
        />
      </details>
      <h3>Milestone acceptance</h3>
      <label>
        Acceptance attempts
        <input
          type="number"
          min={1}
          max={3}
          required
          value={policy.acceptanceAttempts}
          onChange={(e) =>
            setPolicy({ ...policy, acceptanceAttempts: Number(e.target.value) })
          }
        />
      </label>
      <AcceptanceFields
        label="Company"
        value={policy.companyAcceptance}
        onChange={(value) => setPolicy({ ...policy, companyAcceptance: value })}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={!!policy.projectAcceptance}
          onChange={(e) =>
            setPolicy({
              ...policy,
              projectAcceptance: e.target.checked
                ? structuredClone(policy.companyAcceptance)
                : null,
            })
          }
        />
        Use a different acceptance policy for this project
      </label>
      {policy.projectAcceptance && (
        <AcceptanceFields
          label="Project"
          value={policy.projectAcceptance}
          onChange={(value) =>
            setPolicy({ ...policy, projectAcceptance: value })
          }
        />
      )}
      <p className="field-help">
        For a game, include a playtest check that exercises the playable build
        and records its results. New approvals keep a snapshot of this policy.
      </p>
      <div className="actions">
        <button className="primary" disabled={disabled}>
          Save review policy
        </button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  );
}
function AcceptanceFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: AcceptancePolicy;
  onChange(value: AcceptancePolicy): void;
}) {
  return (
    <>
      <label>
        {label} acceptance requirements
        <textarea
          rows={4}
          required
          maxLength={8000}
          value={value.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
        />
      </label>
      <details className="preference-note">
        <summary>
          {label} automated checks ({value.checks.length})
        </summary>
        <p className="field-help">
          Checks run against the integrated candidate in a clean checkout. Every
          check must pass. Arguments are separated by spaces; these commands do
          not use a shell.
        </p>
        {value.checks.map((check, i) => (
          <div className="editor" key={i}>
            <label>
              Check name
              <input
                required
                value={check.name}
                onChange={(e) =>
                  onChange({
                    ...value,
                    checks: value.checks.map((c, n) =>
                      n === i ? { ...c, name: e.target.value } : c,
                    ),
                  })
                }
              />
            </label>
            <label>
              Command
              <input
                required
                value={check.command.join(" ")}
                onChange={(e) =>
                  onChange({
                    ...value,
                    checks: value.checks.map((c, n) =>
                      n === i
                        ? { ...c, command: e.target.value.split(" ") }
                        : c,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              disabled={value.checks.length <= 1}
              onClick={() =>
                onChange({
                  ...value,
                  checks: value.checks.filter((_, n) => n !== i),
                })
              }
            >
              Remove check
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={value.checks.length >= 12}
          onClick={() =>
            onChange({
              ...value,
              checks: [
                ...value.checks,
                { name: "Playtest", command: ["bun", "run", "playtest"] },
              ],
            })
          }
        >
          Add check
        </button>
      </details>
    </>
  );
}
