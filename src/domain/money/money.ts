import { CurrencyMismatchError, InvalidArgumentError } from "../errors";

/** Wire / persistence representation. `amount` is always a decimal string with scale 2. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
// Unsigned decimal with up to 2 fraction digits. No exponent, no sign, no blanks.
const UNSIGNED_DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Immutable monetary value.
 *
 * The amount is held as an integer number of minor units (`bigint`), which is
 * an exact decimal with fixed scale 2 — no binary floating point ever touches
 * money. Parsing is strict: anything that would need rounding is rejected
 * instead of silently rounded.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses an input contract value. Negative amounts are rejected here:
   * contracts only carry magnitudes, the direction comes from the operation.
   */
  static from(props: MoneyProps): Money {
    return new Money(Money.parseUnsigned(props.amount), Money.parseCurrency(props.currency));
  }

  /** Like `from`, but accepts a leading minus. Used to rehydrate signed values (e.g. reconciliation differences). */
  static fromSigned(props: MoneyProps): Money {
    const raw = typeof props.amount === "string" ? props.amount : "";
    const negative = raw.startsWith("-");
    const minor = Money.parseUnsigned(negative ? raw.slice(1) : raw);
    return new Money(negative ? -minor : minor, Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  /** Decimal string with scale 2, e.g. "25.00" or "-3.10". */
  formatAmount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const units = abs / FACTOR;
    const cents = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseUnsigned(amount: unknown): bigint {
    if (typeof amount !== "string") {
      throw new InvalidArgumentError("Money amount must be a decimal string");
    }
    const match = UNSIGNED_DECIMAL.exec(amount);
    if (!match) {
      throw new InvalidArgumentError(
        `Invalid money amount "${amount}": expected a non-negative decimal with at most ${SCALE} fraction digits`,
      );
    }
    const units = BigInt(match[1]!);
    const fraction = (match[2] ?? ".").slice(1).padEnd(SCALE, "0");
    return units * FACTOR + BigInt(fraction);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidArgumentError(`Invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
    return currency;
  }
}
