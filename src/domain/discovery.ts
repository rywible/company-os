import { z } from "zod";
import { permissionSchema } from "./permissions";
import { agentConfigurationSchema, defaultAgentConfiguration } from "./agents";
import { cronFromHours, nextCronOccurrence, validCron } from "./cron";
const text = z.string().trim().min(1);
export const experimentSchema = z.object({
  track: z.enum(["research", "bug", "feature"]),
  mode: z.enum(["analysis", "ui-inspection"]),
  title: text.max(160),
  instruction: text.max(8000),
  criteria: text.max(4000),
});
export type Experiment = z.infer<typeof experimentSchema>;
export const lensSchema = z.object({
  id: text.max(100),
  name: text.max(80),
  question: text.max(2000),
  enabled: z.boolean(),
  kind: z.enum(["research", "knowledge", "planning", "task"]).optional(),
  permissions: z.array(permissionSchema).max(4).optional(),
  targetMilestones: z.number().int().min(1).max(5).optional(),
  schedule: z
    .string()
    .trim()
    .max(100)
    .refine(validCron, "Use a valid five-field cron schedule.")
    .optional(),
  intervalHours: z.number().int().min(1).max(720).optional(),
  dailyRunLimit: z.number().int().min(1).max(24).default(6),
  maxActiveIdeas: z.number().int().min(1).max(20).default(6),
  maxInvestigations: z.number().int().min(1).max(3).default(2),
  maxOpenWork: z.number().int().min(1).max(10).default(4),
  inspectUI: z.boolean().default(false),
  agent: agentConfigurationSchema.default(defaultAgentConfiguration),
  sources: z
    .array(
      z
        .string()
        .regex(
          /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/,
        ),
    )
    .max(3)
    .default([]),
});
export type Lens = z.infer<typeof lensSchema> & {
  lastRunAt?: string;
  lastRunId?: string;
};
export const candidateSchema = z.object({
  title: text.max(160),
  observation: text.max(3000),
  hypothesis: text.max(3000),
  impact: text.max(2000),
  uncertainty: text.max(2000),
  evidence: z.array(text).min(1).max(20),
  experiment: experimentSchema,
});
export const assessmentSchema = z.object({
  verdict: z.enum(["recommend", "discard", "inconclusive"]),
  finding: text.max(6000),
  evidence: z.array(text).min(1).max(20),
  proposedWork: experimentSchema.nullable(),
  nextExperiment: experimentSchema.nullable(),
});
export const outcomeSchema = z.object({
  verdict: z.enum(["improved", "no_benefit", "harmful", "inconclusive"]),
  finding: text.max(6000),
  evidence: z.array(text).min(1).max(20),
});
export type Signal = {
  id: string;
  key: string;
  title: string;
  detail: string;
  lensIds: string[];
  at: string;
  sourceEventId?: string;
  count: number;
  consumedBy?: string;
};
export type Idea = z.infer<typeof candidateSchema> & {
  id: string;
  lensId: string;
  runId: string;
  signalIds: string[];
  status:
    | "candidate"
    | "investigating"
    | "ready"
    | "pursued"
    | "evaluating"
    | "learned"
    | "parked"
    | "discarded";
  investigationWorkIds: string[];
  deliveryWorkId?: string;
  outcomeWorkId?: string;
  threadId?: string;
  knowledgeId?: string;
  assessment?: z.infer<typeof assessmentSchema>;
  outcome?: z.infer<typeof outcomeSchema>;
  decisionReason: string;
  createdAt: string;
  updatedAt: string;
};
export type DiscoveryState = {
  taskSettingsVersion: 1;
  lenses: Lens[];
  ideas: Idea[];
  signals: Signal[];
  observedEvents: string[];
};
export function initialDiscovery(): DiscoveryState {
  const definitions: [string, string, string, number][] = [
    [
      "direction",
      "Direction",
      "Which assumption about what we are building or who it serves should we challenge?",
      168,
    ],
    [
      "users",
      "Users & workflows",
      "Where does using the product create friction, confusion or unnecessary work? Inspect the real UI when useful.",
      24,
    ],
    [
      "product",
      "Product possibilities",
      "What new capability could materially improve a user's outcome? What would we remove to make room?",
      48,
    ],
    [
      "engineering",
      "Engineering health",
      "What concrete bottleneck or source of complexity merits refactoring? Require evidence before proposing a rewrite.",
      48,
    ],
    [
      "operations",
      "Correctness & operations",
      "What failures, risks or missing feedback make the system unreliable?",
      12,
    ],
    [
      "outside",
      "Outside developments",
      "What external change or unfamiliar approach could alter our choices? Identify missing external evidence explicitly; never invent current news.",
      72,
    ],
    [
      "business",
      "Business viability",
      "Which assumption about value, cost or adoption needs a cheap test?",
      168,
    ],
    [
      "learning",
      "Organizational learning",
      "What do our completed work, review findings and failed experiments teach us about how we operate?",
      24,
    ],
    [
      "subtraction",
      "Subtraction",
      "What feature, process, abstraction or recurring work could we delete or simplify?",
      96,
    ],
  ];
  return {
    taskSettingsVersion: 1,
    ideas: [],
    signals: [],
    observedEvents: [],
    lenses: definitions.map(([id, name, question, intervalHours]) => ({
      id,
      name,
      question,
      intervalHours,
      schedule: cronFromHours(intervalHours),
      dailyRunLimit: 6,
      maxActiveIdeas: 6,
      maxInvestigations: 2,
      maxOpenWork: 4,
      enabled: true,
      inspectUI: id === "users",
      agent: defaultAgentConfiguration(),
      sources: id === "outside" ? ["oven-sh/bun"] : [],
    })),
  };
}
export function selectLens(d: DiscoveryState, now: string): Lens | undefined {
  const due = d.lenses.filter(
    (l) =>
      l.enabled &&
      (!l.lastRunAt ||
        Date.parse(
          nextCronOccurrence(
            l.schedule || cronFromHours(l.intervalHours || 24),
            l.lastRunAt,
          ) || ""
        ) <= Date.parse(now) ||
        (d.signals.some((s) => !s.consumedBy && s.lensIds.includes(l.id)) &&
          Date.parse(l.lastRunAt) + 15 * 60000 <= Date.parse(now))),
  );
  return due.sort((a, b) => {
    const attention = (l: Lens) =>
      d.signals.filter((s) => !s.consumedBy && s.lensIds.includes(l.id)).length;
    // Overdue perspectives take priority over recently checked, signalled ones.
    const overdue = (l: Lens) => {
      if (!l.lastRunAt) return 2;
      const dueAt = nextCronOccurrence(
        l.schedule || cronFromHours(l.intervalHours || 24),
        l.lastRunAt,
      );
      return dueAt && Date.parse(now) >= Date.parse(dueAt) ? 2 : 0;
    };
    return (
      Number(overdue(b) >= 2) - Number(overdue(a) >= 2) ||
      attention(b) - attention(a) ||
      (a.lastRunAt || "").localeCompare(b.lastRunAt || "")
    );
  })[0];
}
export function duplicateIdea(
  ideas: Idea[],
  candidate: { title: string; hypothesis: string },
) {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const words = (s: string) =>
    new Set(
      normalize(s)
        .split(" ")
        .filter((w) => w.length > 3),
    );
  return ideas.some((i) => {
    if (normalize(i.title) === normalize(candidate.title)) return true;
    const a = words(i.hypothesis),
      b = words(candidate.hypothesis);
    const intersection = [...a].filter((w) => b.has(w)).length;
    return (
      a.size >= 5 &&
      b.size >= 5 &&
      intersection / (a.size + b.size - intersection) >= 0.8
    );
  });
}
export const discoveryCommands = [
  z.object({ type: z.literal("SaveDiscoveryLens"), lens: lensSchema }),
  z.object({ type: z.literal("DeleteDiscoveryLens"), lensId: text }),
  z.object({ type: z.literal("ExploreDiscovery"), lensId: text.optional() }),
  z.object({
    type: z.literal("RecordDiscoverySignal"),
    content: text.max(8000),
    lensId: text,
  }),
  z.object({
    type: z.literal("DecideDiscovery"),
    ideaId: text,
    action: z.enum(["pursue", "park", "discard", "revisit"]),
    reason: z.string().max(4000),
  }),
] as const;

export type ResearchSource = {
  repository: string;
  fetchedAt: string;
  releases: {
    ref: string;
    title: string;
    url: string;
    publishedAt: string;
    content: string;
  }[];
  error?: string;
};
