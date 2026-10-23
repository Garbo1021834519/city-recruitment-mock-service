import { describe, expect, it } from "vitest";
import { classifyParity, concreteRoute, diffShapes, shapeOf } from "../src/shared/parity.js";

describe("parity utilities", () => {
  it("concretizes FastAPI and local parameter routes without changing query strings", () => {
    expect(concreteRoute("/api/v1/cities/{city_id}/history/:historyId?page=1")).toBe("/api/v1/cities/999999/history/999999");
  });

  it("fingerprints nested arrays by type and population without retaining values", () => {
    expect(shapeOf({ items: [{ id: 1, name: "secret" }], total: 1 })).toEqual({
      items: { __kind: "array", __len: "non-empty", item: { id: "number", name: "string" } },
      total: "number",
    });
  });

  it("reports structural differences and classifies target gateway failures separately", () => {
    const diffs = diffShapes({ items: { __kind: "array", __len: "non-empty" } }, { items: { __kind: "array", __len: "empty" } });
    expect(diffs).toEqual(["items.__len.: non-empty != empty"]);
    expect(classifyParity({ targetStatus: 504, localStatus: 200, diffs: ["status 504 != 200"] })).toBe("target-internal-failure");
    expect(classifyParity({ targetStatus: 200, localStatus: 200, diffs })).toBe("data-dependent");
    expect(classifyParity({
      targetStatus: 200,
      localStatus: 200,
      diffs: ["items.__len.: non-empty != empty", "items.item.: [object Object] != undefined"],
    })).toBe("data-dependent");
    expect(classifyParity({
      targetStatus: 200,
      localStatus: 200,
      diffs: ["items.item.keywords.__len.: empty != non-empty", "items.item.keywords.item.: undefined != string"],
    })).toBe("data-dependent");
    expect(classifyParity({ targetStatus: 200, localStatus: 200, diffs: ["districts.北京: missing locally"] })).toBe("data-dependent");
    expect(classifyParity({ targetStatus: 200, localStatus: 200, diffs: ["items.name: missing locally"] })).toBe("partial");
    expect(classifyParity({ targetStatus: 200, localStatus: 200, diffs: ["items.item.name: missing locally"] })).toBe("partial");
    expect(classifyParity({ targetStatus: 200, localStatus: 200, diffs: [] })).toBe("verified");
  });
});
