import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidArgumentError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("parses and serializes with fixed scale 2", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25.5").toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
    expect(brl("0.01").formatAmount()).toBe("0.01");
    expect(brl("1234567890123456.99").formatAmount()).toBe("1234567890123456.99");
    expect(brl("10.00").toString()).toBe("10.00 BRL");
  });

  test("arithmetic is exact (no binary floating point)", () => {
    expect(brl("0.10").add(brl("0.20")).formatAmount()).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.01")).formatAmount()).toBe("19.99");
    expect(brl("1.00").subtract(brl("1.01")).formatAmount()).toBe("-0.01");
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.formatAmount()).toBe("10.00");
  });

  test("never rounds: more than 2 decimals is rejected", () => {
    expect(() => brl("10.005")).toThrow(InvalidArgumentError);
    expect(() => brl("0.001")).toThrow(InvalidArgumentError);
  });

  test.each([
    ["", "empty"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["1e3", "scientific notation"],
    ["1E-2", "scientific notation"],
    ["-1.00", "negative input"],
    [" 1.00", "whitespace"],
    ["1,00", "comma"],
    ["01.00", "leading zero"],
    [".5", "missing integer part"],
    ["5.", "dangling dot"],
    ["+1", "explicit sign"],
    ["0x10", "hex"],
  ])("rejects %p (%s)", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidArgumentError);
  });

  test("rejects non-string amounts (numbers are not money)", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidArgumentError);
  });

  test("rejects invalid currency codes", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidArgumentError);
    expect(() => Money.from({ amount: "1.00", currency: "REAL" })).toThrow(InvalidArgumentError);
  });

  test("operations across currencies fail with a domain error", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });

  test("is immutable", () => {
    const a = brl("5.00");
    const b = a.add(brl("1.00"));
    expect(a.formatAmount()).toBe("5.00");
    expect(b.formatAmount()).toBe("6.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("predicates and negate", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("1.00").isPositive()).toBe(true);
    expect(brl("1.00").negate().isNegative()).toBe(true);
    expect(brl("1.00").negate().formatAmount()).toBe("-1.00");
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(Money.fromSigned({ amount: "-3.10", currency: "BRL" }).formatAmount()).toBe("-3.10");
  });
});
