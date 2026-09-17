import { lower, searchTokens } from "../src/lib/normalize";

describe("lower", () => {
  it("trims + lowercases + tolerates nullish", () => {
    expect(lower("  Ramesh Kumar ")).toBe("ramesh kumar");
    expect(lower(null)).toBe("");
    expect(lower(undefined)).toBe("");
  });
});

describe("searchTokens (replaces Flask LOWER(bill_no)/LOWER(customer_name) LIKE %q%)", () => {
  const t = searchTokens("FOOD-000123", "Ramesh Kumar");

  it("includes the exact lowercased bill number", () => {
    expect(t).toContain("food-000123");
  });
  it("includes bill-number prefixes so 'food-0001' matches", () => {
    expect(t).toContain("food-0001");
    expect(t).toContain("food-00");
  });
  it("includes name word prefixes (>= 2 chars) so 'ram' and 'ku' match", () => {
    expect(t).toEqual(expect.arrayContaining(["ra", "ram", "rame", "ku", "kum"]));
  });
  it("does NOT include interior substrings (documented degradation)", () => {
    expect(t).not.toContain("mesh"); // 'Ramesh' interior — Flask LIKE would match, Firestore can't
  });
  it("splits on space/comma/dot/underscore/dash", () => {
    const x = searchTokens("", "Anil.Kapoor-Rao");
    expect(x).toEqual(expect.arrayContaining(["an", "ani", "ka", "kap", "ra", "rao"]));
  });
  it("caps token explosion for a pathological name", () => {
    const long = searchTokens("", Array.from({ length: 50 }, (_, i) => "word" + i).join(" "));
    expect(long.length).toBeLessThanOrEqual(256);
  });
  it("handles empty inputs", () => {
    expect(searchTokens("", "")).toEqual([]);
  });
});
