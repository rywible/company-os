import React, { useState } from "react";
import type { Settings } from "../domain/model";
import type { AgentRole } from "../domain/planning";
import type { AgentCatalog, AgentProvider } from "../domain/agents";
import type { CommandHandler } from "./settings";
import {
  AgentConfigurationFields,
  agentConfigurationSummary,
} from "./agent-configuration";

type Shared = { disabled: boolean; command: CommandHandler };
export function RolesSettings({
  settings,
  catalog,
  providers,
  ...shared
}: Shared & {
  settings: Settings;
  catalog: AgentCatalog;
  providers: AgentProvider[];
}) {
  return (
    <section className="preference-section">
      <div className="role-list">
        {settings.roles.map((role) => (
          <RoleForm
            key={role.id}
            role={role}
            catalog={catalog}
            providers={providers}
            {...shared}
          />
        ))}
      </div>
    </section>
  );
}
function RoleForm({
  role,
  catalog,
  providers,
  disabled,
  command,
}: Shared & {
  role: AgentRole;
  catalog: AgentCatalog;
  providers: AgentProvider[];
}) {
  const [value, setValue] = useState(role),
    [saved, setSaved] = useState(false);
  return (
    <details className="role-form">
      <summary>
        <span className="role-identity">
          <strong>{role.name}</strong>
          <span>{role.purpose}</span>
        </span>
        <span className="role-profile">
          {agentConfigurationSummary(role.agent)}
        </span>
        <span className="role-state" data-enabled={role.enabled}>
          {role.enabled ? "Active" : "Paused"}
        </span>
      </summary>
      <form
        className="editor"
        onChange={() => setSaved(false)}
        onSubmit={(e) => {
          e.preventDefault();
          void command({ type: "SaveRole", role: value }).then(setSaved);
        }}
      >
        <label>
          Role name
          <input
            required
            maxLength={80}
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </label>
        <label>
          What this role is good at
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={value.purpose}
            onChange={(e) => setValue({ ...value, purpose: e.target.value })}
          />
        </label>
        <AgentConfigurationFields
          value={value.agent}
          catalog={catalog}
          availableProviders={providers}
          onChange={(agent) => {
            setSaved(false);
            setValue({ ...value, agent });
          }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
          />{" "}
          Enable role
        </label>
        <div className="actions">
          <button className="primary" disabled={disabled}>
            Save {role.name}
          </button>
          {saved && <span role="status">Saved</span>}
        </div>
      </form>
    </details>
  );
}
export function AvailabilitySettings({
  settings,
  disabled,
  command,
}: Shared & { settings: Settings }) {
  const [value, setValue] = useState(settings.availability),
    [saved, setSaved] = useState(false);
  return (
    <form
      className="preference-section editor"
      onChange={() => setSaved(false)}
      onSubmit={(e) => {
        e.preventDefault();
        void command({
          type: "ConfigureAvailability",
          availability: value,
        }).then(setSaved);
      }}
    >
      <label>
        Time zone
        <input
          required
          value={value.timeZone}
          onChange={(e) => setValue({ ...value, timeZone: e.target.value })}
          placeholder="America/Denver"
        />
      </label>
      <fieldset className="availability-days">
        <legend>Available days</legend>
        {[
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ].map((day, i) => (
          <label key={day} className="check">
            <input
              type="checkbox"
              checked={value.days.includes(i)}
              onChange={(e) =>
                setValue({
                  ...value,
                  days: e.target.checked
                    ? [...value.days, i].sort()
                    : value.days.filter((n) => n !== i),
                })
              }
            />
            {day}
          </label>
        ))}
      </fieldset>
      <label>
        From
        <input
          type="time"
          required
          value={value.start}
          onChange={(e) => setValue({ ...value, start: e.target.value })}
        />
      </label>
      <label>
        Until
        <input
          type="time"
          required
          value={value.end}
          onChange={(e) => setValue({ ...value, end: e.target.value })}
        />
      </label>
      <div className="actions">
        <button className="primary" disabled={disabled || !value.days.length}>
          Save availability
        </button>
        {saved && <span role="status">Saved</span>}
      </div>
    </form>
  );
}
