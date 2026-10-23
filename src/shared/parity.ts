export type Shape = string | null | {
  [key: string]: Shape | { __kind: "array"; __len: "empty" | "non-empty"; item?: Shape };
};

export interface ParityResult {
  targetStatus: number;
  localStatus: number;
  diffs: string[];
}

export function concreteRoute(route: string): string {
  return route.replace(/\?.*$/, "").replace(/\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*/g, "999999");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) {
    return {
      __kind: "array",
      __len: value.length > 0 ? "non-empty" : "empty",
      item: value.length && value[0] && typeof value[0] === "object" ? shapeOf(value[0]) : typeOf(value[0]),
    };
  }
  if (value && typeof value === "object") {
    const result: Record<string, Shape> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return typeOf(value);
}

export function diffShapes(target: Shape, local: Shape, at = ""): string[] {
  if (target === null || local === null) return target === local ? [] : [`${at || "<root>"}: ${target} != ${local}`];
  if (typeof target !== "object" || typeof local !== "object") return target === local ? [] : [`${at || "<root>"}: ${target} != ${local}`];

  const targetArray = "__kind" in target && target.__kind === "array";
  const localArray = "__kind" in local && local.__kind === "array";
  if (targetArray || localArray) {
    if (!targetArray || !localArray) return [`${at || "<root>"}: array shape mismatch`];
    const result: string[] = [];
    if (target.__len !== local.__len) result.push(`${at}__len.: ${target.__len} != ${local.__len}`);
    if (target.item !== undefined && local.item !== undefined) result.push(...diffShapes(target.item, local.item, `${at}item.`));
    return result;
  }

  const result: string[] = [];
  for (const key of Object.keys(target)) if (!(key in local)) result.push(`${at}${key}: missing locally`);
  for (const key of Object.keys(local)) if (!(key in target)) result.push(`${at}${key}: extra locally`);
  for (const key of Object.keys(target)) if (key in local) result.push(...diffShapes(target[key], local[key], `${at}${key}.`));
  return result;
}

export function classifyParity(result: ParityResult): "verified" | "partial" | "data-dependent" | "target-internal-failure" {
  if (result.targetStatus >= 500 && result.targetStatus !== result.localStatus) return "target-internal-failure";
  if (!result.diffs.length) return "verified";
  const dataOnly = result.diffs.every((diff) =>
    diff.includes("__len.")
    || /(?:^|\.)item\.: (?:\[object Object\] != undefined|undefined != \[object Object\]|string != undefined|undefined != string)$/.test(diff)
    || /^(?:districts|default_districts|links)\.[^.]+: (?:missing|extra) locally$/.test(diff));
  if (dataOnly) return "data-dependent";
  return "partial";
}
