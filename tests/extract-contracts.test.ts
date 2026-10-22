import { describe, expect, it } from "vitest";
import { extractRouteManifest, extractApiContracts, aggregateApiContracts } from "../scripts/extract-contracts.mjs";

describe("extractRouteManifest", () => {
  it("extracts named routes and lazy chunks from the Vue router block", () => {
    const source = 'const Kee=[{path:"/login",name:"login",component:()=>import("./Login.js")},{path:"cities",name:"cities",component:()=>import("./Cities.js")}];';
    expect(extractRouteManifest(source)).toEqual([
      { path: "/login", name: "login", chunk: "Login.js" },
      { path: "cities", name: "cities", chunk: "Cities.js" },
    ]);
  });
});

describe("extractApiContracts", () => {
  it("records API paths, methods, form fields, and response types", () => {
    const source = 'api.post("/api/v1/login", body); api.get(`/api/v1/items/${id}`); form.append("file", value); responseType:"blob";';
    const result = extractApiContracts(source);
    expect(result.paths).toContainEqual({ method: "POST", path: "/api/v1/login" });
    expect(result.paths).toContainEqual({ method: "GET", path: "/api/v1/items/:id" });
    expect(result.form_fields).toContain("file");
    expect(result.response_types).toContain("blob");
  });

  it("aggregates contracts across lazy chunks", () => {
    expect(aggregateApiContracts([
      'api.get("/api/v1/cities")',
      'api.post("/api/v1/service-positions", body)',
    ]).paths).toEqual([
      { method: "GET", path: "/api/v1/cities" },
      { method: "POST", path: "/api/v1/service-positions" },
    ]);
  });
});
