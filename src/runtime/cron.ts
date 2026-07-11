export interface CronExpression {
  dayOfMonth: CronField;
  dayOfWeek: CronField;
  hour: CronField;
  minute: CronField;
  month: CronField;
  source: string;
}

export interface CronField {
  any: boolean;
  values: Set<number>;
}

interface CronFieldSpec {
  max: number;
  min: number;
  name: string;
  normalize?: (value: number) => number;
}

const FIELD_SPECS: CronFieldSpec[] = [
  { max: 59, min: 0, name: "minute" },
  { max: 23, min: 0, name: "hour" },
  { max: 31, min: 1, name: "day-of-month" },
  { max: 12, min: 1, name: "month" },
  {
    max: 7,
    min: 0,
    name: "day-of-week",
    normalize: (value) => (value === 7 ? 0 : value),
  },
];

export function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error("cron expression must have five fields");
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseCronField(field, FIELD_SPECS[index]!),
  );

  return {
    dayOfMonth: dayOfMonth!,
    dayOfWeek: dayOfWeek!,
    hour: hour!,
    minute: minute!,
    month: month!,
    source: expression,
  };
}

export function cronMatchesDate(cron: CronExpression, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) {
    return false;
  }

  if (!cron.hour.values.has(date.getHours())) {
    return false;
  }

  if (!cron.month.values.has(date.getMonth() + 1)) {
    return false;
  }

  const domMatches = cron.dayOfMonth.values.has(date.getDate());
  const dowMatches = cron.dayOfWeek.values.has(date.getDay());

  if (cron.dayOfMonth.any && cron.dayOfWeek.any) {
    return true;
  }

  if (cron.dayOfMonth.any) {
    return dowMatches;
  }

  if (cron.dayOfWeek.any) {
    return domMatches;
  }

  return domMatches || dowMatches;
}

export function formatCronMinuteKey(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    "-",
    String(date.getMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getDate()).padStart(2, "0"),
    "T",
    String(date.getHours()).padStart(2, "0"),
    ":",
    String(date.getMinutes()).padStart(2, "0"),
  ].join("");
}

function parseCronField(rawField: string, spec: CronFieldSpec): CronField {
  const values = new Set<number>();

  for (const rawPart of rawField.split(",")) {
    const part = rawPart.trim();

    if (!part) {
      throw new Error(`${spec.name} field contains an empty list item`);
    }

    addCronPart(values, part, spec);
  }

  return {
    any: rawField === "*",
    values,
  };
}

function addCronPart(values: Set<number>, part: string, spec: CronFieldSpec): void {
  if (part === "*") {
    addRange(values, spec.min, spec.max, 1, spec);
    return;
  }

  if (part.startsWith("*/")) {
    const step = parseCronNumber(part.slice(2), spec);

    if (step <= 0) {
      throw new Error(`${spec.name} step must be greater than zero`);
    }

    addRange(values, spec.min, spec.max, step, spec);
    return;
  }

  const rangeMatch = /^(.+)-(.+)$/.exec(part);

  if (rangeMatch) {
    const start = parseCronNumber(rangeMatch[1]!, spec);
    const end = parseCronNumber(rangeMatch[2]!, spec);

    if (start > end) {
      throw new Error(`${spec.name} range start must be less than or equal to range end`);
    }

    addRange(values, start, end, 1, spec);
    return;
  }

  values.add(normalizeCheckedValue(parseCronNumber(part, spec), spec));
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  spec: CronFieldSpec,
): void {
  for (let value = start; value <= end; value += step) {
    values.add(normalizeCheckedValue(value, spec));
  }
}

function parseCronNumber(rawValue: string, spec: CronFieldSpec): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${spec.name} field value "${rawValue}" must be a number`);
  }

  const value = Number(rawValue);

  if (value < spec.min || value > spec.max) {
    throw new Error(`${spec.name} field value ${value} is outside ${spec.min}-${spec.max}`);
  }

  return value;
}

function normalizeCheckedValue(value: number, spec: CronFieldSpec): number {
  return spec.normalize ? spec.normalize(value) : value;
}
