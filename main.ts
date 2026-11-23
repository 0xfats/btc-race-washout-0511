/**
 * Dislocation-only cbBTC race bot for make.fun btc-race-24h-20261123-0511.
 *
 * Strategy (validated offline on the kit dev window, then with the kit grader):
 *   - Wait for a real washout: the 15-minute close-to-close return at or below
 *     -0.8%, confirmed by two consecutive up closes (the bounce has started).
 *   - Buy once, full size (all cash), at most 2 round trips in the whole 24h.
 *   - Sell the whole position at +2.0% from the entry close, or on a -0.3% stop
 *     from the entry close, or on a -0.4% pullback from the peak close since entry.
 *   - Otherwise hold cash and do nothing. No shorts, no leverage, no chasing.
 *
 * Why this shape: on the 18 Nov race the winners made exactly 2 trades, buying
 * the one washout and selling the rebound, then stopping. A busy mean-reversion
 * bot fires on every dip and chops itself up on fees (a full round trip costs
 * ~26 bps). This bot only fires on an extreme 15-minute dislocation with a
 * confirmed bounce, so in a quiet window it may trade once, twice, or not at
 * all -- and that is fine: one good washout trade beats ten chopped ones.
 *
 * Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
 * One reply per batch, echoing its seq. Orders decided on a batch fill at the
 * next bar's open. Deterministic: every decision is a pure function of the
 * bars seen so far. No clock, no environment, no randomness, no network, no
 * files. Node 22, standard library only.
 */

const SYMBOL = "CBBTC";

// Strategy parameters (tuned offline on the dev window, see notes above).
const DIP_WINDOW_BARS = 15; // look-back for the dislocation, in 1-minute bars
const DIP_THRESHOLD = -0.008; // 15-min return at or below -0.8% is a washout
const CONFIRM_UPTICKS = 2; // consecutive up closes confirming the bounce
const TAKE_PROFIT = 0.02; // sell at +2.0% from the entry close
const STOP_LOSS = -0.003; // sell at -0.3% from the entry close
const TRAIL_PULLBACK = -0.004; // sell on a -0.4% pullback from the peak since entry
const MAX_ROUND_TRIPS = 2; // at most this many buys in the whole window
const MAX_SLIPPAGE_BPS = 100; // 1%: far above any fill move seen on the dev window

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

type Account = {
  cash_quote_units: string;
  positions: Array<{ symbol: string; qty: string; cost_quote_units: string }>;
};

class Bot {
  private quoteScale: number;
  private priceScale: number;
  private warmupBars: number;
  private cash: number;
  private closes: number[] = [];
  private qty = 0;
  private entryClose: number | null = null;
  private peakClose: number | null = null;
  private buysDone = 0;
  private nextClient = 1;

  constructor(hello: any) {
    this.quoteScale = Number(hello.capital.quote_scale);
    this.cash = Number(hello.capital.quote_units);
    const info = (hello.symbols as any[]).find((s) => s.symbol === SYMBOL);
    this.priceScale = Number(info.price_scale);
    this.warmupBars = Number(hello.warmup_bars ?? 0);
  }

  private clientId(): string {
    return "o" + this.nextClient++;
  }

  private applyAccount(account: Account): void {
    this.cash = Number(account.cash_quote_units);
    let held = 0;
    for (const pos of account.positions ?? []) {
      if (pos.symbol === SYMBOL) held = Number(pos.qty);
    }
    this.qty = held;
    if (held === 0) {
      this.entryClose = null;
      this.peakClose = null;
    }
  }

  private sellAll(): Order {
    return {
      side: "sell",
      client_id: this.clientId(),
      symbol: SYMBOL,
      qty: String(this.qty),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  private decide(seq: number): Order[] {
    if (seq < this.warmupBars) return [];
    if (this.closes.length === 0) return [];
    const close = this.closes[this.closes.length - 1];

    if (this.qty > 0) {
      // Holding: manage the exit.
      if (this.peakClose === null || close > this.peakClose) {
        this.peakClose = close;
      }
      const gain = close / (this.entryClose as number) - 1;
      if (gain >= TAKE_PROFIT) return [this.sellAll()];
      if (gain <= STOP_LOSS) return [this.sellAll()];
      if (close / (this.peakClose as number) - 1 <= TRAIL_PULLBACK) {
        return [this.sellAll()];
      }
      return [];
    }

    // Flat: only a confirmed washout buys, and only twice per window.
    if (this.buysDone >= MAX_ROUND_TRIPS) return [];
    if (this.cash < 10 ** this.quoteScale) return []; // under $1: below min notional
    const n = this.closes.length;
    if (n <= DIP_WINDOW_BARS + CONFIRM_UPTICKS) return [];
    const dip = close / this.closes[n - 1 - DIP_WINDOW_BARS] - 1;
    if (dip > DIP_THRESHOLD) return [];
    for (let j = 0; j < CONFIRM_UPTICKS; j++) {
      if (this.closes[n - 1 - j] <= this.closes[n - 2 - j]) return [];
    }
    this.buysDone += 1;
    this.entryClose = close;
    this.peakClose = close;
    return [
      {
        side: "buy",
        client_id: this.clientId(),
        symbol: SYMBOL,
        notional_quote_units: String(this.cash),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  onBatch(msg: any): Order[] {
    for (const bar of msg.bars ?? []) {
      if (bar.symbol === SYMBOL) {
        this.closes.push(Number(bar.c) / 10 ** this.priceScale);
      }
    }
    this.applyAccount(msg.account as Account);
    return this.decide(Number(msg.seq));
  }

  onDone(msg: any): void {
    this.applyAccount(msg.account as Account);
  }
}

function main(): void {
  let bot: Bot | null = null;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      const msg = JSON.parse(line);
      if (msg.type === "hello") {
        if (msg.protocol !== "agent-fun/bars-replay/v1") {
          throw new Error("unsupported protocol: " + String(msg.protocol));
        }
        bot = new Bot(msg);
      } else if (msg.type === "batch") {
        if (bot === null) throw new Error("batch before hello");
        const orders = bot.onBatch(msg);
        process.stdout.write(
          JSON.stringify(
            { type: "reply", seq: Number(msg.seq), orders },
            // keep the reply on one line, keys in protocol order
          ) + "\n",
        );
      } else if (msg.type === "done") {
        if (bot === null) throw new Error("done before hello");
        bot.onDone(msg);
        process.exit(0);
      } else {
        throw new Error("unknown message type: " + String(msg.type));
      }
    }
  });
  process.stdin.on("end", () => {
    throw new Error("input ended before done");
  });
}

main();
