import React, { useState } from "react";
import type { Settings } from "../domain/model";
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
        Each managed repository owns its CI checks. Company OS waits for review
        and those checks to pass before merging work.
      </p>
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
      <label>
        Requirements for every milestone
        <textarea
          rows={5}
          maxLength={8000}
          placeholder="For example: playtest the complete player journey and record the result."
          value={policy.milestoneRequirements}
          onChange={(e) =>
            setPolicy({ ...policy, milestoneRequirements: e.target.value })
          }
        />
      </label>
      <div className="actions">
        <button className="primary" disabled={disabled}>
          Save review policy
        </button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  );
}
