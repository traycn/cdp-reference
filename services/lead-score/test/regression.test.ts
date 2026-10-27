import { describe, expect, it } from "vitest";
import { Rng } from "@cdp/ingest/rng";
import { fitLogistic, solve } from "../src/regression.ts";

describe("solve", () => {
  it("solves a small system with pivoting", () => {
    expect(
      solve(
        [
          [0, 2],
          [3, 1],
        ],
        [4, 5],
      ).map((x) => Math.round(x * 1e12) / 1e12),
    ).toEqual([1, 2]);
  });

  it("refuses a singular system", () => {
    expect(() =>
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toThrow("singular");
  });
});

describe("fitLogistic", () => {
  const rng = new Rng(1);
  const X: number[][] = [];
  const y: boolean[] = [];
  for (let i = 0; i < 4000; i++) {
    const row = [rng.float() * 2, rng.float() * 2, rng.float() * 2];
    const z = -1 + 1.5 * row[0]! - 1.0 * row[1]! + 0 * row[2]!;
    X.push(row);
    y.push(rng.float() < 1 / (1 + Math.exp(-z)));
  }

  it("recovers the coefficients of a known model", () => {
    const f = fitLogistic(X, y, { lambda: 0, nonNegative: false });
    expect(f.intercept).toBeCloseTo(-1, 0);
    expect(f.coef[0]).toBeCloseTo(1.5, 0);
    expect(f.coef[1]).toBeCloseTo(-1, 0);
    expect(Math.abs(f.coef[2]!)).toBeLessThan(0.2);
    expect(f.zeroed).toEqual([]);
  });

  it("fixes negative coefficients at 0 and refits the rest", () => {
    const f = fitLogistic(X, y, { lambda: 1, nonNegative: true });
    expect(f.coef[1]).toBe(0);
    expect(f.zeroed).toContain(1);
    expect(f.coef.every((c) => c >= 0)).toBe(true);
    expect(f.coef[0]).toBeGreaterThan(1);
  });

  it("shrinks coefficients with a larger penalty", () => {
    const a = fitLogistic(X, y, { lambda: 0, nonNegative: false });
    const b = fitLogistic(X, y, { lambda: 1000, nonNegative: false });
    expect(Math.abs(b.coef[0]!)).toBeLessThan(Math.abs(a.coef[0]!));
  });
});
