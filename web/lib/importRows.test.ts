import { describe, expect, it } from "vitest";
import { importRowsReady, validateImportRows } from "./importRows";
import type { ImportRow } from "./types";

const row = (n: number, over: Partial<ImportRow> = {}): ImportRow => ({
  row: n,
  company: "Acme",
  role: "SWE",
  person: "Jo",
  email: `jo${n}@x.com`,
  subject: "Hi",
  mailText: "Hello",
  followupText: null,
  ...over,
});

describe("validateImportRows (mirrors src/import/parseCsv.js validateRows)", () => {
  it("accepts valid rows, including a null follow-up", () => {
    const p = validateImportRows([row(2), row(3, { followupText: "Ping" })]);
    expect(p).toEqual([{}, {}]);
    expect(importRowsReady([row(2)], p)).toBe(true);
  });

  it("requires every field except the follow-up, trimming first", () => {
    const [p] = validateImportRows([row(2, { company: "  ", role: "", person: "", subject: "", mailText: " \n ", email: "" })]);
    expect(p).toMatchObject({
      company: "Company is required",
      role: "Role is required",
      person: "Person is required",
      email: "Email is required",
      subject: "Subject is required",
      mailText: "Mail Text is required",
    });
    expect(p!.followupText).toBeUndefined();
  });

  it("rejects line breaks and control characters in single-line fields only", () => {
    const [p] = validateImportRows([row(2, { subject: "a\nb", company: "x\u0007", mailText: "line1\nline2", followupText: "a\nb" })]);
    expect(p!.subject).toMatch(/single line/);
    expect(p!.company).toMatch(/single line/);
    expect(p!.mailText).toBeUndefined();
    expect(p!.followupText).toBeUndefined();
  });

  it("enforces 300 characters for short fields and 20000 for texts", () => {
    const [ok] = validateImportRows([row(2, { company: "a".repeat(300), mailText: "m".repeat(20000), followupText: "f".repeat(20000) })]);
    expect(ok).toEqual({});
    const [bad] = validateImportRows([row(2, { company: "a".repeat(301), mailText: "m".repeat(20001), followupText: "f".repeat(20001) })]);
    expect(bad).toMatchObject({ company: "Company is too long", mailText: "Mail Text is too long", followupText: "Follow-up Text is too long" });
  });

  it("uses the server's email rules", () => {
    const bad = ["nope", "a@b", "a b@x.com", "a@x..com", "@x.com", `${"a".repeat(250)}@x.com`];
    for (const email of bad) expect(validateImportRows([row(2, { email })])[0]!.email, email).toBe("Email is not a valid address");
    expect(validateImportRows([row(2, { email: " Jo.Smith+tag@Sub.Example.com " })])).toEqual([{}]);
  });

  it("flags later duplicate emails case-insensitively, keeping the first", () => {
    const p = validateImportRows([row(2, { email: "A@x.com" }), row(3, { email: "a@X.com" }), row(4, { email: "b@x.com" })]);
    expect(p[0]).toEqual({});
    expect(p[1]!.email).toBe("Duplicate email in this list");
    expect(p[2]).toEqual({});
    expect(importRowsReady([row(2), row(3)], p)).toBe(false);
  });

  it("allows at most 500 rows and needs at least one", () => {
    const many = Array.from({ length: 501 }, (_, i) => row(i + 2));
    expect(importRowsReady(many, validateImportRows(many))).toBe(false);
    const max = many.slice(0, 500);
    expect(importRowsReady(max, validateImportRows(max))).toBe(true);
    expect(importRowsReady([], [])).toBe(false);
  });
});
