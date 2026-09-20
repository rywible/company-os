const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function fieldMatches(source: string, value: number, field: number): boolean {
  const [minimum, maximum] = ranges[field]!;
  return source.split(",").some((part) => {
    const [span, stepSource] = part.split("/");
    const step = stepSource ? Number(stepSource) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start: number = minimum;
    let end: number = maximum;
    if (span !== "*") {
      const [startSource, endSource] = span!.split("-");
      start = Number(startSource);
      end = endSource === undefined ? start : Number(endSource);
    }
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= minimum &&
      end <= maximum &&
      start <= end &&
      value >= start &&
      value <= end &&
      (value - start) % step === 0
    );
  });
}

export function validCron(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    if (!/^[\d*,\/-]+$/.test(field!)) return false;
    const [minimum, maximum] = ranges[index]!;
    return Array.from({ length: maximum - minimum + 1 }, (_, offset) =>
      fieldMatches(field!, minimum + offset, index),
    ).some(Boolean);
  });
}

export function nextCronOccurrence(
  schedule: string,
  after: string,
): string | null {
  if (!validCron(schedule)) return null;
  const fields = schedule.trim().split(/\s+/);
  const date = new Date(after);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  // Two years covers sparse annual schedules without permitting an unbounded loop.
  for (let minute = 0; minute < 60 * 24 * 366 * 2; minute++) {
    const dayOfMonthMatches = fieldMatches(fields[2]!, date.getUTCDate(), 2);
    const dayOfWeekMatches =
      fieldMatches(fields[4]!, date.getUTCDay(), 4) ||
      (date.getUTCDay() === 0 && fieldMatches(fields[4]!, 7, 4));
    const dayMatches =
      fields[2] === "*" || fields[4] === "*"
        ? dayOfMonthMatches && dayOfWeekMatches
        : dayOfMonthMatches || dayOfWeekMatches;
    if (
      fieldMatches(fields[0]!, date.getUTCMinutes(), 0) &&
      fieldMatches(fields[1]!, date.getUTCHours(), 1) &&
      dayMatches &&
      fieldMatches(fields[3]!, date.getUTCMonth() + 1, 3)
    )
      return date.toISOString();
    date.setUTCMinutes(date.getUTCMinutes() + 1);
  }
  return null;
}

export function cronFromHours(hours: number): string {
  if (hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (hours === 24) return "0 9 * * *";
  if (hours === 168) return "0 9 * * 1";
  if (hours > 24 && hours % 24 === 0)
    return `0 9 */${Math.min(31, hours / 24)} * *`;
  return "0 9 * * *";
}
